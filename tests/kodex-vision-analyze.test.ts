import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../src/content/buckets.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { analyzeContentStudioMedia } from '../src/kodex/content-studio.js';
import {
  kodexAnalyzeImage,
  kodexMediaAnalyzeUrl,
  readKodexImageAnalysis,
} from '../src/kodex/llm-client.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('vision analysis reads a description and a list of moods', () => {
  const analysis = readKodexImageAnalysis({
    success: true,
    analysis: {
      mainSubject: 'Red field',
      description: 'A uniform deep red background.',
      mood: ['Bold', 'Minimal'],
    },
  });
  assert.equal(analysis.description, 'A uniform deep red background.');
  assert.equal(analysis.mood, 'Bold, Minimal');
  assert.match(analysis.summary, /Red field/);
  assert.equal(
    kodexMediaAnalyzeUrl('https://ai-api.example.test/v1'),
    'https://ai-api.example.test/api/v1/ai/media/analyze',
  );
});

test('kodex image analysis posts the file to the vision service', async () => {
  const previousBase = process.env.KODEX_BASE_URL;
  const previousToken = process.env.KODEX_TOKEN;
  process.env.KODEX_BASE_URL = 'https://ai-api.example.test/v1';
  process.env.KODEX_TOKEN = 'kodex_test_only';
  try {
    let posted = false;
    const result = await kodexAnalyzeImage({
      bytes: png,
      fileName: 'pixel.png',
      contentType: 'image/png',
      fetchImpl: async (url, init) => {
        posted = url === 'https://ai-api.example.test/api/v1/ai/media/analyze'
          && init.method === 'POST'
          && init.body instanceof FormData
          && (init.body as FormData).has('image');
        return new Response(JSON.stringify({
          analysis: { description: 'One red pixel.', mood: 'Bold', mainSubject: 'Pixel' },
        }), { status: 200 });
      },
    });
    assert.equal(posted, true);
    assert.equal(result.description, 'One red pixel.');
  } finally {
    if (previousBase == null) delete process.env.KODEX_BASE_URL;
    else process.env.KODEX_BASE_URL = previousBase;
    if (previousToken == null) delete process.env.KODEX_TOKEN;
    else process.env.KODEX_TOKEN = previousToken;
  }
});

test('content studio uses vision analysis instead of chat image parts', async () => {
  const previousBase = process.env.KODEX_BASE_URL;
  const previousToken = process.env.KODEX_TOKEN;
  process.env.KODEX_BASE_URL = 'https://ai-api.example.test/v1';
  process.env.KODEX_TOKEN = 'kodex_test_only';
  const files = new MemoryFileStorage();
  const objectKey = 'org-vision/post/pixel.png';
  await files.putObject({
    bucket: CONTENT_REVIEW_ASSETS_BUCKET,
    objectKey,
    body: png,
    contentType: 'image/png',
  });
  let sawImage = false;
  try {
    const result = await analyzeContentStudioMedia({
      files,
      organizationId: 'org-vision',
      input: { storagePath: objectKey, fileName: 'pixel.png', clientName: 'Acme' },
      dependencies: {
        gatewayClient: null,
        kodexAnalyzeImage: async () => {
          sawImage = true;
          return {
            description: 'A red product on a table.',
            mood: 'Warm',
            mainSubject: 'Product',
            summary: 'Subject: Product\nDescription: A red product on a table.',
          };
        },
        llmChatText: async ({ userMessage }) => {
          assert.match(userMessage, /A red product on a table/);
          return JSON.stringify({
            mood: 'Warm',
            sceneDescription: 'A red product on a table.',
            generatedCaption: 'The red piece, ready for the table.',
            instagramCaption: 'Red, and ready.',
            facebookCaption: 'A red product for the table.',
          });
        },
      },
    });
    assert.equal(sawImage, true);
    assert.equal(result.sceneDescription, 'A red product on a table.');
    assert.equal(result.generatedCaption, 'The red piece, ready for the table.');
    assert.equal(result.instagramCaption, 'Red, and ready.');
  } finally {
    if (previousBase == null) delete process.env.KODEX_BASE_URL;
    else process.env.KODEX_BASE_URL = previousBase;
    if (previousToken == null) delete process.env.KODEX_TOKEN;
    else process.env.KODEX_TOKEN = previousToken;
  }
});
