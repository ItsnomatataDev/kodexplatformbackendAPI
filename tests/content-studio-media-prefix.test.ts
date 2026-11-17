import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaPrefixMatches } from '../src/content/resumable/media-prefix.js';

function ftyp(brand: string) {
  const bytes = new Uint8Array(32);
  bytes[3] = 24;
  bytes.set(Buffer.from('ftyp'), 4);
  bytes.set(Buffer.from(brand.padEnd(4, ' ')), 8);
  return bytes;
}

test('accepts real MP4 and QuickTime brands as video/mp4', () => {
  for (const brand of ['isom', 'mp42', 'mp41', 'iso6', 'avc1', 'hev1', 'hvc1', 'dash', 'qt  ', 'M4V ']) {
    assert.equal(mediaPrefixMatches('video/mp4', ftyp(brand)), true, brand);
    assert.equal(mediaPrefixMatches('video/quicktime', ftyp(brand)), true, brand);
  }
});

test('rejects still-image ftyp brands as video', () => {
  assert.equal(mediaPrefixMatches('video/mp4', ftyp('avif')), false);
  assert.equal(mediaPrefixMatches('video/mp4', ftyp('heic')), false);
});

test('rejects a JPEG prefix uploaded as mp4', () => {
  assert.equal(mediaPrefixMatches('video/mp4', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false);
});
