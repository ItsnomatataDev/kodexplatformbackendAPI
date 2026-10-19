import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'minio';
import { db } from '../../dist/db/pool.js';
import { PostgresMediaPlatformStore } from '../../dist/media-platform/postgres-store.js';

// Real executable, real PostgreSQL and private MinIO. A loopback proxy holds
// one source GET so crash and pause timing is deterministic, without test hooks
// or shortened lease settings in production code. Never log URLs or child logs.
export async function verifyWorkerLifecycle() {
  const admin = new Client({endPoint:'minio',port:9000,useSSL:false,region:'us-east-1',accessKey:'local-test-admin',secretKey:'local-test-admin-password'});
  const writer = new Client({endPoint:'minio',port:9000,useSSL:false,region:'us-east-1',accessKey:'local-test-worker',secretKey:'local-test-worker-password'});
  const bucket='content-review-assets';
  const store=new PostgresMediaPlatformStore();
  const directory=await mkdtemp(`${tmpdir()}/worker-lifecycle-`);
  const children=[];
  let holdNext=false, held=null;
  const proxy=createServer((req,res)=>{
    const forward=()=>{
      if (res.destroyed) return;
      const upstream=request({hostname:'minio',port:9000,path:req.url,method:req.method,headers:req.headers}, reply=>{
        res.writeHead(reply.statusCode,reply.headers); reply.pipe(res);
      });
      upstream.on('error',()=>{res.writeHead(502);res.end();});
      req.pipe(upstream);
    };
    if (holdNext && req.method==='GET' && req.url.includes('/lifecycle-source.mp4')) {
      holdNext=false; held={release:forward};
    } else forward();
  });
  async function until(fn,label,timeout=60000) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {const value=await fn();if(value)return value;await delay(50);}
    throw Object.assign(new Error('Lifecycle timeout'),{code:`LIFECYCLE_TIMEOUT_${label.replaceAll(' ','_')}`});
  }
  function start() {
    const child=spawn(process.execPath,['dist/media-platform/processing-worker.js'],{
      env:{...process.env,MINIO_ENDPOINT:`http://127.0.0.1:${proxy.address().port}`,MINIO_ACCESS_KEY:'local-test-worker',MINIO_SECRET_KEY:'local-test-worker-password',TMPDIR:directory,LOG_LEVEL:'info'},stdio:['ignore','pipe','ignore']});
    child.events=new Set();
    let buffer='';
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      const lines=buffer.split('\n');buffer=lines.pop();
      // Development logger uses pino-pretty. Retain only this fixed event,
      // never raw logs (which can include private object keys).
      for(const line of lines)if(line.includes('media.worker.lease_lost_failure_ignored'))child.events.add('media.worker.lease_lost_failure_ignored');
    });
    children.push(child);return child;
  }
  async function stop(child,signal='SIGTERM') {
    if(child.exitCode!==null||child.signalCode!==null)return;
    child.kill(signal);
    await until(()=>child.exitCode!==null||child.signalCode!==null,'worker exit',10000);
  }
  async function job(asset) {return (await store.getJobsForAsset('11111111-1111-4111-8111-111111111111',asset.id))[0];}
  async function expire(id) {await db.query("UPDATE media_platform.jobs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[id]);}
  try {
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=854x480:r=24','-t','2','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',`${directory}/source.mp4`],{stdio:'pipe'});
    const bytes=await readFile(`${directory}/source.mp4`);
    await admin.putObject(bucket,'lifecycle-source.mp4',bytes);
    // Finish prior independent fixture jobs so real workers claim only this asset.
    await db.query("UPDATE media_platform.jobs SET status='failed' WHERE status IN ('queued','processing')");
    const asset=await store.createAssetAndJob({organizationId:'11111111-1111-4111-8111-111111111111',originalFilename:'source.mp4',mimeType:'video/mp4',sizeBytes:bytes.length,originBucket:bucket,originObjectKey:'lifecycle-source.mp4'});
    holdNext=true;
    const crashed=start();
    await until(()=>held,'first source held');
    const first=await job(asset);
    assert.equal(first.status,'processing');
    await stop(crashed,'SIGKILL'); held=null;
    assert.equal((await store.getAssetById(asset.id)).hlsGeneration,null);
    await expire(first.id);
    const restarted=start();
    await until(async()=> (await job(asset)).status==='completed','restarted worker publication');
    await stop(restarted);
    const second=await job(asset);
    assert.ok(BigInt(second.fencingToken)>BigInt(first.fencingToken));
    assert.equal(second.attempts,2);
    const published=(await store.getAssetById(asset.id)).hlsGeneration;
    const key=`.media/v2/${asset.id}/${published}/hls/master.m3u8`;
    const before=await admin.statObject(bucket,key);
    // A paused real process resumes after its lease was recovered by a new process.
    await store.enqueueForOrganization(asset.organizationId,asset.id);
    holdNext=true;
    const paused=start();
    await until(()=>held,'paused source held');
    const stale=await job(asset);
    paused.kill('SIGSTOP');
    await expire(stale.id);
    const replacement=start();
    await until(async()=> (await job(asset)).status==='completed','replacement publication');
    await stop(replacement);
    const current=await job(asset);
    assert.ok(BigInt(current.fencingToken)>BigInt(stale.fencingToken));
    paused.kill('SIGCONT'); held.release(); held=null;
    // Wait for real obsolete processor upload; database publication must remain fenced.
    const staleKey=`.media/v2/${asset.id}/${stale.fencingToken}/hls/master.m3u8`;
    await until(async()=>{try{return await admin.statObject(bucket,staleKey);}catch{return false;}},'obsolete upload completes');
    await until(()=>paused.events.has('media.worker.lease_lost_failure_ignored'),'stale worker rejects publication');
    await stop(paused);
    assert.equal((await store.getAssetById(asset.id)).hlsGeneration,current.fencingToken);
    assert.equal((await job(asset)).fencingToken,current.fencingToken);
    // Retain-all policy: service IAM cannot remove active, previous or orphan generations.
    for(const token of [published,current.fencingToken,stale.fencingToken]) {
      const objectKey=`.media/v2/${asset.id}/${token}/hls/master.m3u8`;
      await assert.rejects(()=>writer.removeObject(bucket,objectKey),error=>error.code==='AccessDenied');
      assert.ok((await admin.statObject(bucket,objectKey)).size>0);
    }
    assert.equal((await admin.statObject(bucket,key)).etag,before.etag,'previous granted generation retained byte-for-byte');
    console.log('Real worker SIGKILL/restart, SIGSTOP/lease recovery/resume, stale upload fencing and no-delete generation retention: passed');
  } finally {
    for(const child of children) {child.kill('SIGCONT');child.kill('SIGKILL');}
    proxy.closeAllConnections(); await new Promise(resolve=>proxy.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
}
