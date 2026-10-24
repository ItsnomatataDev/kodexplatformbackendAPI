import assert from 'node:assert/strict';
import { Client } from 'minio';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createMediaPlaybackUrl } from '../../dist/media-platform/playback/url.js';
import { issuePlaybackGrant } from './grants.mjs';
import { processAdaptiveHls } from '../../dist/media-platform/processing/adaptive-hls.js';
import { probeVideo } from '../../dist/media-platform/processing/ffmpeg.js';

// Disposable credentials only; no environment or production services are used.
const admin = new Client({ endPoint: 'minio', port: 9000, useSSL: false,
  accessKey: 'local-test-admin', secretKey: 'local-test-admin-password', region: 'us-east-1' });
const bucket = 'content-review-assets';
const assetId = '0c8176a7-87c6-4f97-bf09-6c1fcf32acce';
const generation = '900000';
const secret = 'local-test-playback-key';
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
async function request(path, options) {
  await issuePlaybackGrant(path, secret);
  return fetch(`http://media-edge:8080${path}`, options);
}
async function main() {
  if (process.env.TEST_PHASE === 'auth-outage') {
    const path = createMediaPlaybackUrl({assetId,generation,secret}).path;
    check((await request(path)).status === 502,'warm cache fails closed on auth outage');
    console.log('Auth outage with warm cache: passed');
    return;
  }
  await admin.makeBucket(bucket);
  // The orchestrator provisions a GetObject-only reader using MinIO mc.
  const directory = await mkdtemp('/tmp/media-cdn-');
  const objects = new Map();
  try {
    const sourcePath = `${directory}/source.mp4`;
    execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=1920x1080:r=24',
      '-t','3','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',sourcePath], {stdio:'pipe'});
    const signal = AbortSignal.timeout(120000);
    const storage = {
      async putObject({objectKey, body, contentType}) {
        const bytes = Buffer.from(body); objects.set(objectKey, bytes);
        await admin.putObject(bucket, objectKey, bytes, bytes.length, {'Content-Type':contentType});
      },
      async putObjectStream({objectKey, body, contentType}) {
        const parts = []; for await (const chunk of body) parts.push(Buffer.from(chunk));
        await this.putObject({objectKey,body:Buffer.concat(parts),contentType});
      },
    };
    const result = await processAdaptiveHls({
      asset: {id:assetId,originBucket:bucket},
      generation,
      source: {directory,inputPath:sourcePath,probe:await probeVideo(sourcePath,signal)},
      storage,
      store: {async upsertVariant(input) {return {...input,id:input.kind};}, async updateVariantStatus() {}},
      signal,
    });
    check(result.renditionCount === 3,'three real encoded renditions');
    for (const [index, [width, height]] of [[1080, 608], [720, 404], [480, 270]].entries()) {
      const variant = result.variants[index];
      check(variant.width === width && variant.height === height, `${variant.kind} long-edge dimensions`);
      const encoded = await probeVideo(`${directory}/hls-${variant.kind.slice(4)}/index.m3u8`, signal);
      check(encoded.width === width && encoded.height === height, `${variant.kind} encoded dimensions`);
    }
    const legacyPath = createMediaPlaybackUrl({assetId,secret}).path;
    await admin.putObject(bucket,`.media/v1/${assetId}/hls/master.m3u8`,Buffer.from('#EXTM3U\n'));
    check((await request(legacyPath)).status === 200,'legacy v1 delivery preserved');
    const path = createMediaPlaybackUrl({assetId,generation,secret}).path;
    const master = await request(path);
    check(master.status === 200,'master status');
    check(master.headers.get('content-type')?.includes('mpegurl'),'master MIME');
    check(master.headers.get('x-media-cache') === 'MISS','cold master');
    const masterText = await master.text();
    check(!masterText.includes('X-Amz') && !masterText.includes('minio'),'no origin URLs');
    const warm = await request(path);
    check(warm.headers.get('x-media-cache') === 'HIT','warm master'); await warm.arrayBuffer();
    for (const [key, bytes] of objects) {
      const objectPath = path.replace('hls/master.m3u8', key.split(`/${assetId}/${generation}/`)[1]);
      const response = await request(objectPath);
      check(response.status === 200,'HLS object delivered');
      check(Buffer.from(await response.arrayBuffer()).equals(bytes),'HLS byte identity');
      check(response.headers.get('content-type')?.includes(key.endsWith('.m3u8') ? 'mpegurl' : 'video/mp4'),'HLS MIME');
      check(![...response.headers].some(([k,v]) => k.startsWith('x-media-origin') || v.includes('X-Amz-')),'no signing disclosure');
      if (key.endsWith('index.m3u8')) {
        const playlist = bytes.toString();
        const relatives = [...playlist.matchAll(/URI="([^"]+)"/g)].map(m=>m[1]);
        relatives.push(...playlist.split('\n').filter(l=>l && !l.startsWith('#')));
        for (const relative of relatives) {
          const child = await fetch(new URL(relative, `http://media-edge:8080${objectPath}`));
          check(child.status === 200,'relative HLS child'); await child.arrayBuffer();
        }
      }
    }
    for (const relative of masterText.split('\n').filter(l=>l && !l.startsWith('#'))) {
      const rendition = await fetch(new URL(relative,`http://media-edge:8080${path}`));
      check(rendition.status === 200,'relative master child'); await rendition.arrayBuffer();
    }
    const reader = new Client({endPoint:'minio',port:9000,useSSL:false,region:'us-east-1',
      accessKey:'local-test-reader',secretKey:'local-test-reader-password'});
    let deniedWrite = false;
    try { await reader.putObject(bucket,'forbidden',Buffer.from('x')); } catch { deniedWrite = true; }
    check(deniedWrite,'reader cannot write');
    const missingPath = path.replace('master.m3u8','480p/segment_99999.m4s');
    check((await request(missingPath)).status === 404,'missing origin object');
    await storage.putObject({objectKey:`.media/v2/${assetId}/${generation}/hls/480p/segment_99999.m4s`,body:Buffer.from('new'),contentType:'video/mp4'});
    check((await request(missingPath)).status === 200,'origin errors were not cached');
    const shortPath = createMediaPlaybackUrl({assetId,generation,secret,ttlSeconds:2}).path;
    check((await request(shortPath)).status === 200,'renewed token shares cache');
    await new Promise(resolve => setTimeout(resolve,2100));
    check((await request(shortPath)).status === 403,'warm token expires');
    const segmentPath = path.replace('master.m3u8','480p/segment_00000.m4s');
    const range = await request(segmentPath,{headers:{Range:'bytes=0-15'}});
    check(range.status === 206 && (await range.arrayBuffer()).byteLength === 16,'range bytes');
    check((await request(segmentPath,{headers:{Range:'bytes=999999999-'}})).status === 416,'unsatisfiable range');
    const head = await request(path,{method:'HEAD'});
    check(head.status === 200 && (await head.arrayBuffer()).byteLength === 0,'HEAD uses signed GET');
    const expired = createMediaPlaybackUrl({assetId,generation,secret,now:Math.floor(Date.now()/1000)-10,ttlSeconds:1}).path;
    const invalid = createMediaPlaybackUrl({assetId,generation,secret:'wrong'}).path;
    for (const denied of [expired,invalid,path+'?extra=1',path.replace('master.m3u8','private.txt')]) {
      const response = await request(denied);
      check(response.status === 403,'authorization denied with cache warm');
    }
    check((await request('/_media_auth')).status === 404,'internal auth inaccessible');
    check((await request(path,{method:'POST'})).status === 405,'method denied');
    check((await fetch(`http://minio:9000/${bucket}/.media/v2/${assetId}/${generation}/hls/master.m3u8`)).status === 403,'origin private');
    // Delete only this disposable fixture: valid cached reads still work,
    // while invalid requests stay denied and an uncached object is absent.
    await admin.removeObject(bucket,`.media/v2/${assetId}/${generation}/hls/master.m3u8`);
    check((await request(path)).status === 200,'authorized cached object survives origin deletion');
    check((await request(expired)).status === 403,'expired cache access denied');
    // Restore the fixture for the separate browser playback verification.
    await admin.putObject(bucket,`.media/v2/${assetId}/${generation}/hls/master.m3u8`,objects.get(`.media/v2/${assetId}/${generation}/hls/master.m3u8`));
    console.log(`Private origin HTTP and FFmpeg integration: ${checks} checks passed`);
  } finally { await rm(directory,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error?.code === 'ERR_ASSERTION' ? `Assertion failed: ${error.message}` : 'Private CDN integration failed (details suppressed to avoid signed URL disclosure)'); process.exitCode=1; });
