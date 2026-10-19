import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaPlaybackUrl } from './url.js';
import { verifyMediaEdgeRequest } from './edge-auth.js';
import { mediaOriginObjectKey } from './origin-signer.js';
const assetId='12345678-1234-4123-8123-123456789abc';
const secret='test-only-generation-secret';
test('v2 generation is signed and maps every child into the immutable attempt prefix',()=>{
  const grant=createMediaPlaybackUrl({assetId,secret,generation:'987'});
  for(const suffix of ['master.m3u8','1080p/index.m3u8','720p/init.mp4','480p/segment_00001.m4s']) {
    const uri=grant.path.replace('master.m3u8',suffix);
    const verification=verifyMediaEdgeRequest({uri,secret});
    assert.ok(verification.valid);
    if(verification.valid) assert.equal(mediaOriginObjectKey(assetId,verification.objectPath,verification.generation),`.media/v2/${assetId}/987/hls/${suffix}`);
    assert.equal(verifyMediaEdgeRequest({uri:uri.replace('/987/','/988/'),secret}).valid,false);
  }
  assert.equal(verifyMediaEdgeRequest({uri:grant.path.replace('/v2/','/v1/').replace('/987/','/'),secret}).valid,false);
});
test('generation identifiers reject traversal and malformed values',()=>{
  for(const generation of ['0','-1','01','../old','1/2','1?x','9'.repeat(20)]) {
    assert.throws(()=>createMediaPlaybackUrl({assetId,secret,generation}));
  }
});
