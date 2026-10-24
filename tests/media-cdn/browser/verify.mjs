import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createMediaPlaybackUrl } from '../../../dist/media-platform/playback/url.js';
import { issuePlaybackGrant } from '../grants.mjs';

// Separate test page only. No application frontend changes, traces, screenshots,
// raw network logs or persisted grants. Restrict execution to the local fixture.
const edge=process.env.MEDIA_TEST_EDGE;
assert.match(edge??'',/^http:\/\/127\.0\.0\.1:\d+$/);
const hls=await readFile(new URL('./node_modules/hls.js/dist/hls.min.js',import.meta.url));
const servers=[];
let browser;
try {
  for(const port of [43181,43182]) {
    const server=createServer((req,res)=>{
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Referrer-Policy','no-referrer');
      if(req.url==='/hls.js'){res.setHeader('Content-Type','text/javascript');res.end(hls);}
      else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Private CDN verification</title><video muted playsinline></video><script src="/hls.js"></script>');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);}); servers.push(server);
  }
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext();
  const page=await context.newPage();
  const responses={master:0,rendition:0,init:0,segment:0};
  page.on('response',res=>{
    if(res.status()!==200)return;
    const path=new URL(res.url()).pathname;
    if(path.endsWith('/master.m3u8'))responses.master++;
    else if(path.endsWith('/index.m3u8'))responses.rendition++;
    else if(path.endsWith('/init.mp4'))responses.init++;
    else if(path.endsWith('.m4s'))responses.segment++;
  });
  const secret='local-test-playback-key';
  const grant=(ttlSeconds=60)=>edge+createMediaPlaybackUrl({assetId:'0c8176a7-87c6-4f97-bf09-6c1fcf32acce',generation:'900000',secret,ttlSeconds}).path;
  async function granted(ttlSeconds=60) {
    const url=grant(ttlSeconds);
    await issuePlaybackGrant(new URL(url).pathname, secret);
    return url;
  }
  await page.goto('http://127.0.0.1:43181');
  const playback=await page.evaluate(async url=>{
    const video=document.querySelector('video');video.muted=true;
    return new Promise(resolve=>{
      const timeout=setTimeout(()=>finish({passed:false,reason:'timeout'}),20000);
      const player=new Hls({debug:false});
      function finish(result){clearTimeout(timeout);player.destroy();resolve(result);}
      video.ontimeupdate=()=>{if(video.currentTime>0.5)finish({passed:true,width:video.videoWidth,height:video.videoHeight});};
      player.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal)finish({passed:false,reason:data.type});});
      player.on(Hls.Events.MANIFEST_PARSED,()=>{video.play().catch(()=>finish({passed:false,reason:'play rejected'}));});
      player.loadSource(url);player.attachMedia(video);
    });
  },await granted());
  assert.equal(playback.passed,true,'actual HLS decoding and advancing playback');
  assert.ok(playback.width>0 && playback.height>0);
  for(const [kind,count] of Object.entries(responses))assert.ok(count>0,`${kind} requested by browser player`);
  const short=await granted(2);
  assert.equal(await page.evaluate(async url=>(await fetch(url)).status,short),200);
  await new Promise(resolve=>setTimeout(resolve,2200));
  for(const suffix of ['master.m3u8','480p/index.m3u8','480p/init.mp4','480p/segment_00000.m4s']) {
    assert.equal(await page.evaluate(async url=>(await fetch(url)).status,short.replace('master.m3u8',suffix)),403,'expired grant readable as 403 via CORS');
  }
  assert.equal(await page.evaluate(async url=>(await fetch(url)).status,await granted()),200,'new grant restores access');
  const range=await page.evaluate(async url=>{
    const response=await fetch(url,{headers:{Range:'bytes=0-15','If-Range':'"fixture-nonmatching-etag"'}});
    return {status:response.status,bytes:(await response.arrayBuffer()).byteLength};
  },(await granted()).replace('master.m3u8','480p/segment_00000.m4s'));
  assert.ok([200,206].includes(range.status) && range.bytes>0,'allowed preflight plus range request');
  assert.equal(await page.evaluate(async url=>{
    try{await fetch(url,{headers:{'X-Unapproved':'x'}});return false;}catch{return true;}
  },await granted()),true,'unapproved preflight header blocked');
  await page.goto('http://127.0.0.1:43182');
  assert.equal(await page.evaluate(async url=>{try{await fetch(url);return false;}catch{return true;}},await granted()),true,'disallowed browser origin blocked');
  assert.equal(await page.evaluate(async url=>{try{await fetch(url,{headers:{'If-Range':'x'}});return false;}catch{return true;}},await granted()),true,'disallowed preflight blocked');
  console.log(`Browser Chrome ${browser.version()}: HLS decoding, master/rendition/init/segments, grant expiry/renewal, allowed and denied CORS/preflight passed`);
} catch {
  console.error('Browser verification FAILED (details suppressed to keep bearer URLs out of logs). Requires local Chrome and npm ci --prefix tests/media-cdn/browser.');
  process.exitCode=1;
} finally {
  await browser?.close();
  await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
}
