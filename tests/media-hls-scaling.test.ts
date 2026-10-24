import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evenDimension, fitWithinLongEdge, selectRenditions } from '../src/media-platform/processing/adaptive-hls.js';

for (const [width, height, expected] of [
  [1920, 1080, [[1080, 608], [720, 404], [480, 270]]],
  [1080, 1920, [[608, 1080], [404, 720], [270, 480]]],
  [320, 240, [[320, 240]]],
] as const) {
  test(`HLS ${width}x${height}: exact dimensions, selection and no upscaling`, () => {
    const renditions = selectRenditions(width, height, '/scratch');
    assert.deepEqual(renditions.map(r => [r.width, r.height]), expected);
    assert.deepEqual(renditions.map(r => r.name), width === 320 ? ['480p'] : ['1080p', '720p', '480p']);
    for (const r of renditions) {
      assert.ok(r.width <= width && r.height <= height);
      assert.equal(r.width % 2, 0);
      assert.equal(r.height % 2, 0);
      // Rounding to even pixels permits a small aspect-ratio error.
      assert.ok(Math.abs(r.width / r.height - width / height) < 0.01);
    }
  });
}

test('selection uses the long edge in both orientations at ladder boundaries', () => {
  for (const [long, names] of [[479, ['480p']], [480, ['480p']], [719, ['480p']], [720, ['720p', '480p']], [1079, ['720p', '480p']], [1080, ['1080p', '720p', '480p']]] as const) {
    for (const [w, h] of [[long, 240], [240, long]]) {
      assert.deepEqual(selectRenditions(w, h, '/scratch').map(r => r.name), names);
    }
  }
});

test('fit clamps scale at one, including odd source dimensions', () => {
  assert.deepEqual(fitWithinLongEdge(320, 240, 1080), { width: 320, height: 240 });
  assert.deepEqual(fitWithinLongEdge(321, 241, 1080), { width: 320, height: 240 });
  assert.deepEqual(fitWithinLongEdge(241, 321, 1080), { width: 240, height: 320 });
});

test('evenDimension rounds first then reduces odd integers', () => {
  for (const [input, expected] of [[607.5, 608], [405, 404], [270, 270], [321, 320], [2, 2]]) {
    assert.equal(evenDimension(input), expected);
  }
});
