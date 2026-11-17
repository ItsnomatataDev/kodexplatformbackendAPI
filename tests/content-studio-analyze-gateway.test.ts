import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createKodexAiGatewayClient,
  type KodexAiGatewayLogEvent,
} from '../src/ai-gateway/client.js';
import { parseKodexAiGatewayConfig } from '../src/ai-gateway/config.js';
import {
  KodexAiGatewayAuthError,
  KodexAiGatewayForbiddenError,
  KodexAiGatewayOverloadedError,
  KodexAiGatewayTimeoutError,
  KodexAiGatewayUnavailableError,
} from '../src/ai-gateway/errors.js';
import { CONTENT_REVIEW_ASSETS_BUCKET } from '../src/content/buckets.js';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { ValidationError } from '../src/http/errors.js';
import {
  analyzeContentStudioMedia,
  generateContentStudioCaption,
} from '../src/kodex/content-studio.js';

const TOKEN = 'test-kodex-app-credential-0001';
const ORG = 'org-content-studio-1';
const OTHER_ORG = 'org-content-studio-2';
const OBJECT_KEY = `${ORG}/schedule/pixel.png`;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const liveVisionFixture = {
  ok: true,
  assistant: 'kodex',
  analysis: {
    sceneDescription: 'A single test pixel.',
    mood: 'neutral',
    mainSubject: 'Red pixel',
    uncertainDetails: 'Exact print size is unclear.',
  },
  captions: {
    generatedCaption: 'A red pixel.',
    instagram: 'A red pixel on Instagram.',
    facebook: 'A red pixel on Facebook.',
    hook: 'Look closer.',
    shortAlternative: 'Red.',
    callToAction: 'Save this.',
    hashtags: ['test', 'pixel'],
    rationale: 'Simple and specific.',
    requiresReview: true,
  },
  requiresReview: true,
};

function enabledConfig() {
  return parseKodexAiGatewayConfig({
    KODEX_AI_GATEWAY_ENABLED: 'true',
    KODEX_AI_GATEWAY_BASE_URL: 'http://127.0.0.1:13100',
    KODEX_AI_GATEWAY_TOKEN: TOKEN,
    KODEX_AI_GATEWAY_TIMEOUT_MS: '1000',
    KODEX_AI_GATEWAY_ANALYZE_TIMEOUT_MS: '1000',
  });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function disabledGateway() {
  return createKodexAiGatewayClient({
    config: parseKodexAiGatewayConfig({}),
    fetchImpl: async () => {
      throw new Error('disabled gateway must not be called');
    },
  });
}

async function seededFiles(body: Buffer = png) {
  const files = new MemoryFileStorage();
  await files.putObject({
    bucket: CONTENT_REVIEW_ASSETS_BUCKET,
    objectKey: OBJECT_KEY,
    body,
    contentType: 'image/png',
  });
  return files;
}

function analyzeDeps(options: {
  fetchImpl?: typeof fetch;
  logs?: KodexAiGatewayLogEvent[];
  llmCalls?: unknown[];
  llmReady?: boolean;
  llmText?: string;
  gateway?: ReturnType<typeof createKodexAiGatewayClient> | null;
}) {
  const logs = options.logs ?? [];
  const llmCalls = options.llmCalls ?? [];
  const gateway =
    options.gateway === undefined
      ? createKodexAiGatewayClient({
          config: enabledConfig(),
          fetchImpl: options.fetchImpl ?? (async () => jsonResponse(200, liveVisionFixture)),
          logger: (event) => logs.push(event),
        })
      : options.gateway;
  return {
    logs,
    llmCalls,
    dependencies: {
      gatewayClient: gateway,
      isLlmReady: () => options.llmReady ?? true,
      llmVisionText: async (input: { prompt: string; imageDataUrl: string }) => {
        llmCalls.push(input);
        if (options.llmText != null) return options.llmText;
        throw new Error('llmVisionText should not run');
      },
    },
  };
}

test('disabled gateway keeps the existing llmVisionText path', async () => {
  const files = await seededFiles();
  const { llmCalls, dependencies } = analyzeDeps({
    gateway: disabledGateway(),
    llmText: JSON.stringify({
      mood: 'calm',
      sceneDescription: 'A lake at dusk.',
      generatedCaption: 'Quiet water.',
      instagramCaption: 'Quiet water on IG.',
    }),
  });
  const result = await analyzeContentStudioMedia({
    files,
    organizationId: ORG,
    input: { storagePath: OBJECT_KEY, fileName: 'pixel.png' },
    dependencies,
  });
  assert.equal(llmCalls.length, 1);
  assert.equal(result.mood, 'calm');
  assert.equal(result.sceneDescription, 'A lake at dusk.');
  assert.equal(result.generatedCaption, 'Quiet water.');
  assert.equal(result.instagramCaption, 'Quiet water on IG.');
  assert.equal(result.facebookCaption, 'Quiet water.');
});

test('enabled gateway analyzes authorized organization bytes and maps genuine fields', async () => {
  const files = await seededFiles();
  const logs: KodexAiGatewayLogEvent[] = [];
  let fetched = 0;
  const { llmCalls, dependencies } = analyzeDeps({
    logs,
    fetchImpl: async (_input, init) => {
      fetched += 1;
      assert.equal(init?.body instanceof FormData, true);
      const form = init?.body as FormData;
      assert.equal(form.has('image'), true);
      return jsonResponse(200, liveVisionFixture);
    },
  });
  const result = await analyzeContentStudioMedia({
    files,
    organizationId: ORG,
    input: { storagePath: OBJECT_KEY, fileName: 'pixel.png' },
    dependencies,
  });
  assert.equal(fetched, 1);
  assert.equal(llmCalls.length, 0);
  assert.equal(result.mood, 'neutral');
  assert.equal(result.sceneDescription, 'Red pixel. A single test pixel.');
  assert.equal(
    result.generatedCaption,
    'Look closer.\n\nA red pixel on Instagram.\n\nSave this.',
  );
  assert.equal(result.instagramCaption, 'A red pixel on Instagram.');
  assert.equal(result.facebookCaption, 'A red pixel on Facebook.');
  assert.equal(result.hook, 'Look closer.');
  assert.equal(result.shortAlternative, 'Red.');
  assert.equal(result.callToAction, 'Save this.');
  assert.deepEqual(result.hashtags, ['test', 'pixel']);
  assert.equal(result.rationale, 'Simple and specific.');
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(png.toString('base64')), false);
  assert.equal(serialized.includes('A red pixel.'), false);
});

test('empty Ubuntu fields stay empty and are not copied into platform captions', async () => {
  const files = await seededFiles();
  const { dependencies } = analyzeDeps({
    fetchImpl: async () =>
      jsonResponse(200, {
        assistant: 'kodex',
        analysis: { sceneDescription: 'A single test pixel.' },
        captions: {
          generatedCaption: 'A red pixel.',
          requiresReview: true,
        },
        requiresReview: true,
      }),
  });
  const result = await analyzeContentStudioMedia({
    files,
    organizationId: ORG,
    input: { storagePath: OBJECT_KEY },
    dependencies,
  });
  assert.equal(result.mood, '');
  assert.equal(result.hook, '');
  assert.equal(result.hashtags.length, 0);
  assert.equal(result.instagramCaption, '');
  assert.equal(result.facebookCaption, '');
  assert.equal(result.generatedCaption, 'A red pixel.');
});

test('Apply caption uses the longest genuine caption, including joined arrays', async () => {
  const files = await seededFiles();
  const { dependencies } = analyzeDeps({
    fetchImpl: async () =>
      jsonResponse(200, {
        assistant: 'kodex',
        analysis: { sceneDescription: 'A lodge deck at dusk.' },
        captions: {
          generatedCaption: 'Dusk on the deck.',
          instagram: [
            'Golden light on the deck.',
            'The river goes quiet and the evening opens up.',
            'Stay for one more colour in the sky.',
          ],
          facebook: 'Short Facebook line.',
          hook: 'Golden hour.',
          callToAction: 'Book the deck.',
          requiresReview: true,
        },
        requiresReview: true,
      }),
  });
  const result = await analyzeContentStudioMedia({
    files,
    organizationId: ORG,
    input: { storagePath: OBJECT_KEY },
    dependencies,
  });
  assert.equal(
    result.generatedCaption,
    [
      'Golden hour.',
      'Golden light on the deck.\n\nThe river goes quiet and the evening opens up.\n\nStay for one more colour in the sky.',
      'Book the deck.',
    ].join('\n\n'),
  );
  assert.equal(result.instagramCaption.includes('The river goes quiet'), true);
});

test('requiresReview false keeps analysis and drops actionable suggestions', async () => {
  const files = await seededFiles();
  const { llmCalls, dependencies } = analyzeDeps({
    fetchImpl: async () =>
      jsonResponse(200, {
        assistant: 'kodex',
        analysis: { sceneDescription: 'A single test pixel.', mood: 'quiet' },
        captions: {
          generatedCaption: 'A red pixel.',
          instagram: 'Do not apply this.',
          hashtags: ['skip'],
          requiresReview: false,
        },
        requiresReview: false,
      }),
  });
  const result = await analyzeContentStudioMedia({
    files,
    organizationId: ORG,
    input: { storagePath: OBJECT_KEY },
    dependencies,
  });
  assert.equal(llmCalls.length, 0);
  assert.equal(result.sceneDescription, 'A single test pixel.');
  assert.equal(result.mood, 'quiet');
  assert.equal(result.generatedCaption, '');
  assert.equal(result.instagramCaption, '');
  assert.equal(result.facebookCaption, '');
  assert.equal(result.hook, '');
  assert.deepEqual(result.hashtags, []);
});

test('cross-organization storagePath is rejected before inference', async () => {
  const files = await seededFiles();
  let fetched = 0;
  const { llmCalls, dependencies } = analyzeDeps({
    fetchImpl: async () => {
      fetched += 1;
      return jsonResponse(200, liveVisionFixture);
    },
  });
  await assert.rejects(
    () =>
      analyzeContentStudioMedia({
        files,
        organizationId: OTHER_ORG,
        input: { storagePath: OBJECT_KEY },
        dependencies,
      }),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.message.includes('organization'),
  );
  assert.equal(fetched, 0);
  assert.equal(llmCalls.length, 0);
});

test('remote http image URLs are not fetched', async () => {
  const files = new MemoryFileStorage();
  let fetched = 0;
  const { dependencies } = analyzeDeps({
    fetchImpl: async () => {
      fetched += 1;
      return jsonResponse(200, liveVisionFixture);
    },
  });
  await assert.rejects(
    () =>
      analyzeContentStudioMedia({
        files,
        organizationId: ORG,
        input: { imageUrl: 'https://example.invalid/secret.jpg' },
        dependencies,
      }),
    ValidationError,
  );
  assert.equal(fetched, 0);
});

test('gateway 8 MiB limit is enforced without compression or LLM fallback', async () => {
  const files = await seededFiles(Buffer.alloc(8 * 1024 * 1024 + 1, 1));
  let fetched = 0;
  const { llmCalls, dependencies } = analyzeDeps({
    fetchImpl: async () => {
      fetched += 1;
      return jsonResponse(200, liveVisionFixture);
    },
  });
  await assert.rejects(
    () =>
      analyzeContentStudioMedia({
        files,
        organizationId: ORG,
        input: { storagePath: OBJECT_KEY },
        dependencies,
      }),
    (error: unknown) =>
      error instanceof ValidationError && error.message.includes('8 MiB'),
  );
  assert.equal(fetched, 0);
  assert.equal(llmCalls.length, 0);
});

test('LLM path still allows images up to 12 MiB when the gateway is disabled', async () => {
  const files = await seededFiles(Buffer.alloc(9 * 1024 * 1024, 2));
  const { llmCalls, dependencies } = analyzeDeps({
    gateway: disabledGateway(),
    llmText: JSON.stringify({ sceneDescription: 'large' }),
  });
  const result = await analyzeContentStudioMedia({
    files,
    organizationId: ORG,
    input: { storagePath: OBJECT_KEY },
    dependencies,
  });
  assert.equal(llmCalls.length, 1);
  assert.equal(result.sceneDescription, 'large');
});

for (const [status, ErrorType] of [
  [401, KodexAiGatewayAuthError],
  [403, KodexAiGatewayForbiddenError],
  [429, KodexAiGatewayOverloadedError],
  [500, KodexAiGatewayUnavailableError],
  [503, KodexAiGatewayUnavailableError],
] as const) {
  test(`gateway HTTP ${status} fails closed without LLM fallback`, async () => {
    const files = await seededFiles();
    const { llmCalls, dependencies } = analyzeDeps({
      fetchImpl: async () => jsonResponse(status, { error: TOKEN }),
    });
    await assert.rejects(
      () =>
        analyzeContentStudioMedia({
          files,
          organizationId: ORG,
          input: { storagePath: OBJECT_KEY },
          dependencies,
        }),
      ErrorType,
    );
    assert.equal(llmCalls.length, 0);
  });
}

test('gateway timeout fails closed without LLM fallback', async () => {
  const files = await seededFiles();
  const { llmCalls, dependencies } = analyzeDeps({
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const error = new Error('Aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  await assert.rejects(
    () =>
      analyzeContentStudioMedia({
        files,
        organizationId: ORG,
        input: { storagePath: OBJECT_KEY },
        dependencies,
      }),
    KodexAiGatewayTimeoutError,
  );
  assert.equal(llmCalls.length, 0);
});

test('data:image payloads are analyzed without fetching remote URLs', async () => {
  const files = new MemoryFileStorage();
  let fetched = 0;
  const { dependencies } = analyzeDeps({
    fetchImpl: async () => {
      fetched += 1;
      return jsonResponse(200, liveVisionFixture);
    },
  });
  const result = await analyzeContentStudioMedia({
    files,
    organizationId: ORG,
    input: {
      imageDataUrl: `data:image/png;base64,${png.toString('base64')}`,
      fileName: 'frame.png',
    },
    dependencies,
  });
  assert.equal(fetched, 1);
  assert.equal(result.sceneDescription, 'Red pixel. A single test pixel.');
});

test('generateContentStudioCaption is still a text-LLM export', () => {
  assert.equal(typeof generateContentStudioCaption, 'function');
});
