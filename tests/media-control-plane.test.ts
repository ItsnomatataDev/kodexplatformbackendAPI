import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import type { MediaControlPlaneStore } from '../src/routes/media-platform.js';
import type { MediaAsset, MediaJob, MediaVariant } from '../src/media-platform/types.js';
import type { ContentStore } from '../src/content/store.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../src/content/buckets.js';
import { ServiceUnavailableError, UnauthorizedError } from '../src/http/errors.js';
import { verifyMediaEdgeRequest } from '../src/media-platform/playback/edge-auth.js';
import { MemoryPlaybackGrantStore } from '../src/media-platform/playback/redis-grant.js';
import { authContext, orgA, orgB, sessionAuth, tokenService, userA } from './work-harness.js';
const id='12345678-1234-4123-8123-123456789abc';
const secret='local-test-only-playback-key-with-32-bytes';
async function fixture() {
  let context=authContext({membership:{isAdminRole:false,permissions:{content_studio:{read:true,manage:true}}}});
  let active=true, registrations=0, originReads=0, enqueues=0;
  const asset: MediaAsset={id,organizationId:orgA,uploadedBy:userA,originalFilename:'source.mp4',mimeType:'video/mp4',
    sizeBytes:5,originBucket:CONTENT_REVIEW_ASSETS_BUCKET,originObjectKey:`${orgA}/private-source.mp4`,status:'ready',
    fencingToken:'17',hlsGeneration:'17',playbackGeneration:null,errorCode:null,errorMessage:null,createdAt:new Date(),updatedAt:new Date()};
  const variant={id:'variant',assetId:id,kind:'hls_480p',status:'ready',bucket:'private-bucket',objectKey:'.media/v2/private',generation:'17',
    width:854,height:480,bitrateBps:1200000,codec:'h264',container:'hls',sizeBytes:100,createdAt:new Date(),updatedAt:new Date()} as MediaVariant;
  const job={id:'job',assetId:id,jobType:'adaptive_hls',status:'failed',attempts:3,maxAttempts:3,
    errorCode:'internal_failure',errorMessage:'secret object key'} as MediaJob;
  const store: MediaControlPlaneStore={
    async createAssetAndJob(input) { registrations++; assert.equal(input.organizationId,orgA); assert.equal(input.uploadedBy,userA); return asset; },
    async getAssetForOrganization(org,assetId) { return org===orgA && assetId===id ? asset : null; },
    async getJobsForAsset() { return [job]; },
    async getVariantsByAssetId() { return [variant]; },
    async enqueueForOrganization(org,assetId) { if (org!==orgA || assetId!==id) return null; enqueues++; return {...job,status:'queued'}; },
    async createReadyImageAsset() { throw new Error('media_source_conflict'); },
  };
  const grants=new MemoryPlaybackGrantStore();
  const files=new MemoryFileStorage();
  await files.putObject({bucket:CONTENT_REVIEW_ASSETS_BUCKET,objectKey:asset.originObjectKey,body:Buffer.from('video'),contentType:'video/mp4'});
  const head=files.headObject.bind(files);
  files.headObject=async (...args)=>{originReads++; return head(...args);};
  const app=createApp({mediaPlatform:store,files,
    mediaPlayback:{secret,publicBaseUrl:'https://media.example.invalid',grants},
    content:{async findMediaOwnership(org,key) { return org===orgA && key===asset.originObjectKey; }} as ContentStore,
    auth:{verifier:tokenService,resolveAuthContext:async()=>context,
      requireActiveSession:async(s,u)=>{if(!active) throw new UnauthorizedError(); return sessionAuth.requireActiveSession(s,u);}}});
  const {authorization}=await sessionAuth.issueBearer(userA);
  const request=(path='',method='GET',body?:unknown)=>app.request(`/api/media-platform/assets${path}`,{
    method,headers:{authorization,'content-type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  return {app,asset,grants,request,revoke:()=>{context.membership.permissions={};},revokeSession:()=>{active=false;},
    otherTenant:()=>{context={...context,membership:{...context.membership,organizationId:orgB},organization:{...context.organization,organizationId:orgB}};},
    readOnly:()=>{context.membership.permissions={content_studio:{read:true}};},counts:()=>({registrations,originReads,enqueues})};
}

test('registers only an owned existing video and rejects origin/tenant overrides',async()=>{
  const f=await fixture();
  const response=await f.request('','POST',{sourceObjectKey:f.asset.originObjectKey});
  assert.equal(response.status,202); assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.text(); assert.ok(!body.includes('originObjectKey')); assert.ok(!body.includes('originBucket'));
  for (const extra of [{organizationId:orgB},{bucket:'other'},{uploadedBy:userA},{status:'ready'}]) {
    assert.equal((await f.request('','POST',{sourceObjectKey:f.asset.originObjectKey,...extra})).status,400);
  }
  assert.equal((await f.request('','POST',{sourceObjectKey:'foreign/private.mp4'})).status,404);
  assert.deepEqual(f.counts(),{registrations:1,originReads:1,enqueues:0});
});
test('cross-tenant reads, variants, processing, playback and registration fail without origin access',async()=>{
  const f=await fixture(); f.otherTenant();
  for (const [path,method] of [[`/${id}`,'GET'],[`/${id}/variants`,'GET'],[`/${id}/process`,'POST'],[`/${id}/playback`,'POST']]) {
    const response=await f.request(path,method); assert.equal(response.status,404);
    assert.ok(!(await response.text()).includes('.media/'));
  }
  assert.equal((await f.request('','POST',{sourceObjectKey:f.asset.originObjectKey})).status,404);
  assert.deepEqual(f.counts(),{registrations:0,originReads:0,enqueues:0});
});
test('permissions and sessions are resolved again for every grant request',async()=>{
  const f=await fixture();
  const initial=await f.request(`/${id}/playback`,'POST'); assert.equal(initial.status,200);
  const grant=await initial.json() as {playbackUrl:string;expiresAt:number};
  const verified=verifyMediaEdgeRequest({uri:new URL(grant.playbackUrl).pathname,secret});
  assert.ok(verified.valid); if(verified.valid) {
    assert.equal(verified.generation,'17');
    assert.equal((await f.grants.get(verified.signature))?.assetId,id);
  }
  assert.ok(grant.expiresAt <= Math.floor(Date.now()/1000)+300);
  f.revoke();
  for (const [path,method] of [[`/${id}`,'GET'],[`/${id}/variants`,'GET'],[`/${id}/process`,'POST'],[`/${id}/playback`,'POST'],['','POST']]) {
    assert.equal((await f.request(path,method)).status,403);
  }
  f.revokeSession(); assert.equal((await f.request(`/${id}/playback`,'POST')).status,401);
});
test('read-only users cannot enqueue; status and variants omit private metadata and errors',async()=>{
  const f=await fixture(); f.readOnly();
  assert.equal((await f.request(`/${id}/process`,'POST')).status,403);
  for(const path of [`/${id}`,`/${id}/variants`]) {
    const response=await f.request(path); assert.equal(response.status,200);
    const text=await response.text();
    for(const forbidden of ['originBucket','objectKey','secret object key','fencingToken','leaseOwner','private-bucket']) assert.ok(!text.includes(forbidden));
  }
  f.asset.hlsGeneration=null; f.asset.status='failed';
  const response=await f.request(`/${id}/playback`,'POST'); assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,'MEDIA_NOT_READY');
});
test('all mounted control-plane routes require existing Bearer session authentication',async()=>{
  const f=await fixture();
  for(const [path,method] of [['','POST'],[`/${id}`,'GET'],[`/${id}/variants`,'GET'],[`/${id}/process`,'POST'],[`/${id}/playback`,'POST']]) {
    assert.equal((await f.app.request(`/api/media-platform/assets${path}`,{method})).status,401);
  }
});
test('fails closed when playback grant storage is unavailable',async()=>{
  const asset: MediaAsset={id,organizationId:orgA,uploadedBy:userA,originalFilename:'source.mp4',mimeType:'video/mp4',
    sizeBytes:5,originBucket:CONTENT_REVIEW_ASSETS_BUCKET,originObjectKey:`${orgA}/private-source.mp4`,status:'ready',
    fencingToken:'17',hlsGeneration:'17',playbackGeneration:null,errorCode:null,errorMessage:null,createdAt:new Date(),updatedAt:new Date()};
  const grants={
    async issue(){throw new ServiceUnavailableError('MEDIA_PLAYBACK_UNAVAILABLE');},
    async get(){return null;},
    async revokeUser(){},
  };
  const app=createApp({
    mediaPlatform:{
      async createAssetAndJob(){return asset;},
      async createReadyImageAsset(){throw new Error('media_source_conflict');},
      async getAssetForOrganization(org,assetId){return org===orgA && assetId===id ? asset : null;},
      async getJobsForAsset(){return [];},
      async getVariantsByAssetId(){return [];},
      async enqueueForOrganization(){return null;},
    },
    files:new MemoryFileStorage(),
    mediaPlayback:{secret,publicBaseUrl:'https://media.example.invalid',grants},
    content:{async findMediaOwnership(){return true;}} as unknown as ContentStore,
    auth:{verifier:tokenService,resolveAuthContext:async()=>authContext({membership:{isAdminRole:false,permissions:{content_studio:{read:true,manage:true}}}}),
      requireActiveSession:async(s,u)=>sessionAuth.requireActiveSession(s,u)},
  });
  const {authorization}=await sessionAuth.issueBearer(userA);
  const response=await app.request(`/api/media-platform/assets/${id}/playback`,{
    method:'POST',headers:{authorization,'content-type':'application/json'},
  });
  assert.equal(response.status,503);
});
test('registers an owned image onto the signed original path without an HLS job',async()=>{
  const imageKey=`${orgA}/photo.jpg`;
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xdb,0x00,0x43,0x00,0xff,0xd9]);
  let published: MediaAsset | null=null;
  const files=new MemoryFileStorage();
  await files.putObject({bucket:CONTENT_REVIEW_ASSETS_BUCKET,objectKey:imageKey,body:jpeg,contentType:'image/jpeg'});
  const grants=new MemoryPlaybackGrantStore();
  const app=createApp({
    mediaPlatform:{
      async createAssetAndJob(){throw new Error('hls-not-for-images');},
      async createReadyImageAsset(input){
        published={id,organizationId:orgA,uploadedBy:userA,originalFilename:'photo.jpg',mimeType:input.mimeType,
          sizeBytes:input.sizeBytes,originBucket:input.originBucket,originObjectKey:input.originObjectKey,status:'ready',
          fencingToken:'9',hlsGeneration:null,playbackGeneration:'9',errorCode:null,errorMessage:null,createdAt:new Date(),updatedAt:new Date()};
        return published;
      },
      async getAssetForOrganization(org,assetId){return org===orgA && assetId===id ? published : null;},
      async getJobsForAsset(){return [];},
      async getVariantsByAssetId(){return [];},
      async enqueueForOrganization(){return null;},
    },
    files,
    mediaPlayback:{secret,publicBaseUrl:'https://media.example.invalid',grants},
    content:{async findMediaOwnership(org: string,key: string){return org===orgA && key===imageKey;}} as unknown as ContentStore,
    auth:{verifier:tokenService,resolveAuthContext:async()=>authContext({membership:{isAdminRole:false,permissions:{content_studio:{read:true,manage:true}}}}),
      requireActiveSession:async(s,u)=>sessionAuth.requireActiveSession(s,u)},
  });
  const {authorization}=await sessionAuth.issueBearer(userA);
  const created=await app.request('/api/media-platform/assets',{
    method:'POST',headers:{authorization,'content-type':'application/json'},
    body:JSON.stringify({sourceObjectKey:imageKey}),
  });
  assert.equal(created.status,202);
  const body=await created.json() as {asset:{playbackReady:boolean;mimeType:string}};
  assert.equal(body.asset.playbackReady,true);
  assert.equal(body.asset.mimeType,'image/jpeg');
  const copied=await files.getObject(CONTENT_REVIEW_ASSETS_BUCKET,`.media/v2/${id}/9/image/original.jpg`);
  assert.ok(copied);
  const playback=await app.request(`/api/media-platform/assets/${id}/playback`,{
    method:'POST',headers:{authorization,'content-type':'application/json'},
  });
  assert.equal(playback.status,200);
  const grant=await playback.json() as {playbackUrl:string};
  assert.match(grant.playbackUrl,/\/image\/original\.jpg$/);
});
