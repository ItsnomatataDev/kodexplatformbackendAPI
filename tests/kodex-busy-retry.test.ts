import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TooManyRequestsError } from '../src/http/errors.js';
import { kodexAnalyzeImage } from '../src/kodex/llm-client.js';

process.env.KODEX_BASE_URL = 'https://kodex.example/v1';
process.env.KODEX_TOKEN = 'kodex_test_token';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const busy = () =>
  new Response(JSON.stringify({ error: 'Inference capacity exhausted. Retry later.' }), {
    status: 429,
    headers: { 'retry-after': '5' },
  });
const ok = () =>
  new Response(
    JSON.stringify({ success: true, analysis: { mainSubject: 'Helicopter', description: 'A helicopter on a pad.', mood: ['Bold'] } }),
    { status: 200 },
  );

test('vision waits for gateway capacity instead of failing on 429', async () => {
  const responses = [busy(), busy(), ok()];
  const sleeps: number[] = [];
  let calls = 0;
  const analysis = await kodexAnalyzeImage({
    bytes: png,
    contentType: 'image/png',
    fetchImpl: async () => {
      calls += 1;
      return responses.shift()!;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.match(analysis.summary, /Helicopter/);
});

test('vision reports a clear busy error once the wait budget is spent', async () => {
  let calls = 0;
  await assert.rejects(
    kodexAnalyzeImage({
      bytes: png,
      contentType: 'image/png',
      busyWaitMs: 1000,
      fetchImpl: async () => {
        calls += 1;
        return busy();
      },
      sleep: async () => undefined,
    }),
    (error: unknown) =>
      error instanceof TooManyRequestsError &&
      error.status === 429 &&
      /busy/i.test(error.message),
  );
  assert.equal(calls, 1);
});
