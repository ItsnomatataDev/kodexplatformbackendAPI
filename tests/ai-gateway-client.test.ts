import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createKodexAiGatewayClient,
  type KodexAiGatewayLogEvent,
} from '../src/ai-gateway/client.js';
import {
  isKodexAiGatewayConfigured,
  isKodexAiWorkspaceGatewayConfigured,
  parseKodexAiGatewayConfig,
} from '../src/ai-gateway/config.js';
import {
  KodexAiGatewayAuthError,
  KodexAiGatewayForbiddenError,
  KodexAiGatewayInvalidResponseError,
  KodexAiGatewayNotConfiguredError,
  KodexAiGatewayOverloadedError,
  KodexAiGatewayTimeoutError,
  KodexAiGatewayUnavailableError,
} from '../src/ai-gateway/errors.js';

const TOKEN = 'test-kodex-app-credential-0001';
const PROMPT = 'Hello KODEX';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

function clientWith(
  fetchImpl: typeof fetch,
  logs: KodexAiGatewayLogEvent[] = [],
) {
  return createKodexAiGatewayClient({
    config: enabledConfig(),
    fetchImpl,
    logger: (event) => logs.push(event),
  });
}

function assertLogsSafe(logs: KodexAiGatewayLogEvent[]) {
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(PROMPT), false);
  assert.equal(serialized.includes('Bearer '), false);
}

test('defaults to disabled without configuration', () => {
  const config = parseKodexAiGatewayConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.workspaceChatEnabled, false);
  assert.equal(config.token, '');
  const client = createKodexAiGatewayClient({ config });
  assert.equal(client.isConfigured(), false);
  assert.equal(client.isWorkspaceChatConfigured(), false);
});

test('workspace chat flag is independent of Content Studio vision', () => {
  const workspaceOnly = parseKodexAiGatewayConfig({
    KODEX_AI_WORKSPACE_GATEWAY_ENABLED: 'true',
    KODEX_AI_GATEWAY_ENABLED: 'false',
    KODEX_AI_GATEWAY_BASE_URL: 'http://127.0.0.1:13100',
    KODEX_AI_GATEWAY_TOKEN: TOKEN,
  });
  assert.equal(workspaceOnly.enabled, false);
  assert.equal(workspaceOnly.workspaceChatEnabled, true);
  assert.equal(isKodexAiGatewayConfigured(workspaceOnly), false);
  assert.equal(isKodexAiWorkspaceGatewayConfigured(workspaceOnly), true);

  const visionOnly = parseKodexAiGatewayConfig({
    KODEX_AI_GATEWAY_ENABLED: 'true',
    KODEX_AI_WORKSPACE_GATEWAY_ENABLED: 'false',
    KODEX_AI_GATEWAY_BASE_URL: 'http://127.0.0.1:13100',
    KODEX_AI_GATEWAY_TOKEN: TOKEN,
  });
  assert.equal(visionOnly.enabled, true);
  assert.equal(visionOnly.workspaceChatEnabled, false);
  assert.equal(isKodexAiGatewayConfigured(visionOnly), true);
  assert.equal(isKodexAiWorkspaceGatewayConfigured(visionOnly), false);
});

test('missing configuration rejects chat without a network call', async () => {
  let called = false;
  const client = createKodexAiGatewayClient({
    config: parseKodexAiGatewayConfig({}),
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, { message: 'nope' });
    },
  });
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayNotConfiguredError);
  assert.equal(called, false);
});

test('rejects the broad local-development credential', () => {
  assert.throws(
    () =>
      parseKodexAiGatewayConfig({
        KODEX_AI_GATEWAY_ENABLED: 'true',
        KODEX_AI_GATEWAY_BASE_URL: 'http://127.0.0.1:13100',
        KODEX_AI_GATEWAY_TOKEN: 'local-development',
      }),
    /local-development/,
  );
});

test('successful KODEX chat', async () => {
  const logs: KodexAiGatewayLogEvent[] = [];
  const captured: { url: string; init: RequestInit | undefined } = {
    url: '',
    init: undefined,
  };
  const client = clientWith(async (input, init) => {
    captured.url = String(input);
    captured.init = init;
    return jsonResponse(200, { assistant: 'kodex', message: 'Hello from KODEX' });
  }, logs);

  const result = await client.chat({ message: PROMPT });
  assert.equal(result.assistant, 'kodex');
  assert.equal(result.message, 'Hello from KODEX');
  assert.equal(captured.url, 'http://127.0.0.1:13100/api/v1/ai/chat');
  assert.equal(captured.init?.method, 'POST');
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`);
  assert.equal(captured.init?.body, JSON.stringify({ assistant: 'kodex', message: PROMPT }));
  assertLogsSafe(logs);
});

const liveVisionFixture = {
  ok: true,
  assistant: 'kodex',
  model: 'qwen3-vl:4b',
  analysis: {
    sceneDescription: 'A single test pixel.',
    objects: [],
  },
  captions: {
    generatedCaption: 'A red pixel.',
    instagramCaption: 'A red pixel.',
    facebookCaption: 'A red pixel.',
    hashtags: ['test'],
    requiresReview: true,
  },
  requiresReview: true,
};

test('successful image analysis', async () => {
  const logs: KodexAiGatewayLogEvent[] = [];
  const captured: { url: string; form: FormData | null } = { url: '', form: null };
  const client = clientWith(async (input, init) => {
    captured.url = String(input);
    captured.form = init?.body instanceof FormData ? init.body : null;
    return jsonResponse(200, { analysis: 'A single test pixel.' });
  }, logs);

  const result = await client.analyzeImage({
    image: png,
    fileName: 'pixel.png',
    contentType: 'image/png',
  });
  assert.equal(result.analysis, 'A single test pixel.');
  assert.equal(captured.url, 'http://127.0.0.1:13100/api/v1/ai/media/analyze');
  assert.ok(captured.form);
  assert.equal(captured.form.has('image'), true);
  assertLogsSafe(logs);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(png.toString('base64')), false);
});

test('HTTP 200 structured vision body is accepted when requiresReview is true', async () => {
  const logs: KodexAiGatewayLogEvent[] = [];
  const client = clientWith(async () => jsonResponse(200, liveVisionFixture), logs);
  const result = await client.analyzeImage({ image: png, fileName: 'pixel.png' });
  assert.equal(result.analysis, 'A single test pixel.');
  assert.equal(result.generatedCaption, 'A red pixel.');
  assert.equal(result.requiresReview, true);
  assertLogsSafe(logs);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('A red pixel.'), false);
  assert.equal(serialized.includes('A single test pixel.'), false);
});

test('structured vision body without string analysis is the live INVALID_RESPONSE failure', async () => {
  const body = {
    ok: true,
    assistant: 'kodex',
    analysis: { objects: ['pixel'] },
    captions: {
      generatedCaption: 'A red pixel.',
      requiresReview: true,
    },
    requiresReview: true,
  };
  const logs: KodexAiGatewayLogEvent[] = [];
  const client = clientWith(async () => jsonResponse(200, body), logs);
  try {
    await client.analyzeImage({ image: png, fileName: 'pixel.png' });
    assert.fail('expected invalid response');
  } catch (error) {
    assert.ok(error instanceof KodexAiGatewayInvalidResponseError);
    assert.equal(error.details?.category, 'missing_field');
    assert.equal(error.details?.fieldPath, 'analysis.sceneDescription');
    assert.equal(JSON.stringify(error.details).includes('A red pixel.'), false);
  }
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('A red pixel.'), false);
});

test('unreviewed captions can be omitted for Content Studio mapping', async () => {
  const client = clientWith(async () =>
    jsonResponse(200, {
      assistant: 'kodex',
      analysis: { sceneDescription: 'A single test pixel.' },
      captions: { generatedCaption: 'A red pixel.', requiresReview: false },
    }),
  );
  const result = await client.analyzeImage(
    { image: png, fileName: 'pixel.png' },
    { unreviewedCaptions: 'omit' },
  );
  assert.equal(result.analysis, 'A single test pixel.');
  assert.equal(result.generatedCaption, null);
  assert.equal(result.requiresReview, false);
});

test('actionable captions require requiresReview true', async () => {
  const client = clientWith(async () =>
    jsonResponse(200, {
      assistant: 'kodex',
      analysis: { sceneDescription: 'A single test pixel.' },
      captions: { generatedCaption: 'A red pixel.', requiresReview: false },
    }),
  );
  try {
    await client.analyzeImage({ image: png, fileName: 'pixel.png' });
    assert.fail('expected requiresReview failure');
  } catch (error) {
    assert.ok(error instanceof KodexAiGatewayInvalidResponseError);
    assert.equal(error.details?.category, 'requires_review');
    assert.equal(error.details?.fieldPath, 'captions.requiresReview');
  }
});

test('accepts platform caption fields instead of generatedCaption', async () => {
  const client = clientWith(async () =>
    jsonResponse(200, {
      assistant: 'kodex',
      analysis: { sceneDescription: 'A single test pixel.' },
      captions: {
        instagram: 'A red pixel on Instagram.',
        facebook: 'A red pixel on Facebook.',
        hashtags: ['red', 'pixel'],
        requiresReview: true,
      },
      requiresReview: true,
    }),
  );
  const result = await client.analyzeImage({ image: png, fileName: 'pixel.png' });
  assert.equal(result.generatedCaption, 'A red pixel on Instagram.');
  assert.equal(result.requiresReview, true);
});

test('does not treat hashtags as a generated caption', async () => {
  const client = clientWith(async () =>
    jsonResponse(200, {
      assistant: 'kodex',
      analysis: { sceneDescription: 'A single test pixel.' },
      captions: { hashtags: ['red', 'pixel'], requiresReview: true },
      requiresReview: true,
    }),
  );
  try {
    await client.analyzeImage({ image: png, fileName: 'pixel.png' });
    assert.fail('expected missing caption failure');
  } catch (error) {
    assert.ok(error instanceof KodexAiGatewayInvalidResponseError);
    assert.equal(error.details?.category, 'missing_field');
    assert.equal(error.details?.fieldPath, 'captions.generatedCaption');
  }
});

test('does not fabricate missing generated captions', async () => {
  const client = clientWith(async () =>
    jsonResponse(200, {
      assistant: 'kodex',
      analysis: { sceneDescription: 'A single test pixel.' },
      captions: { requiresReview: true },
      requiresReview: true,
    }),
  );
  try {
    await client.analyzeImage({ image: png, fileName: 'pixel.png' });
    assert.fail('expected missing caption failure');
  } catch (error) {
    assert.ok(error instanceof KodexAiGatewayInvalidResponseError);
    assert.equal(error.details?.category, 'missing_field');
    assert.equal(error.details?.fieldPath, 'captions.generatedCaption');
  }
});

test('invalid credentials', async () => {
  const logs: KodexAiGatewayLogEvent[] = [];
  const client = clientWith(async () => jsonResponse(401, { error: TOKEN }), logs);
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayAuthError);
  assertLogsSafe(logs);
});

test('forbidden operation', async () => {
  const client = clientWith(async () => jsonResponse(403, { error: 'nope' }));
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayForbiddenError);
});

test('gateway overload', async () => {
  const client = clientWith(async () => jsonResponse(429, { error: 'slow down' }));
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayOverloadedError);
});

test('gateway 5xx', async () => {
  const client = clientWith(async () => jsonResponse(503, { error: 'down' }));
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayUnavailableError);
});

test('network unavailable', async () => {
  const logs: KodexAiGatewayLogEvent[] = [];
  const client = clientWith(async () => {
    throw new TypeError('fetch failed');
  }, logs);
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayUnavailableError);
  assertLogsSafe(logs);
});

test('timeout', async () => {
  const logs: KodexAiGatewayLogEvent[] = [];
  const client = clientWith(async (_url, init) => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    const signal = init?.signal;
    if (signal?.aborted) {
      throw error;
    }
    await new Promise<void>((_, reject) => {
      signal?.addEventListener('abort', () => reject(error));
    });
    return jsonResponse(200, { message: 'late' });
  }, logs);
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayTimeoutError);
  assertLogsSafe(logs);
});

test('malformed response', async () => {
  const client = clientWith(async () => jsonResponse(200, { ok: true, foo: 1 }));
  await assert.rejects(
    () => client.chat({ message: PROMPT }),
    KodexAiGatewayInvalidResponseError,
  );
});

test('does not retry after a failed inference request', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return jsonResponse(503, { error: 'down' });
  });
  await assert.rejects(() => client.chat({ message: PROMPT }), KodexAiGatewayUnavailableError);
  assert.equal(calls, 1);
});

test('multi-turn chat sends assistant kodex and messages[] and reads reply', async () => {
  const logs: KodexAiGatewayLogEvent[] = [];
  const captured: { body: string } = { body: '' };
  const config = parseKodexAiGatewayConfig({
    KODEX_AI_WORKSPACE_GATEWAY_ENABLED: 'true',
    KODEX_AI_GATEWAY_BASE_URL: 'http://127.0.0.1:13100',
    KODEX_AI_GATEWAY_TOKEN: TOKEN,
    KODEX_AI_GATEWAY_TIMEOUT_MS: '1000',
  });
  const client = createKodexAiGatewayClient({
    config,
    fetchImpl: async (_input, init) => {
      captured.body = String(init?.body);
      return jsonResponse(200, {
        assistant: 'kodex',
        model: 'qwen2.5:1.5b',
        reply: 'Hello from KODEX',
        message: 'should-not-win',
      });
    },
    logger: (event) => logs.push(event),
  });
  const messages = [
    { role: 'system' as const, content: 'You are Kode AI.' },
    { role: 'user' as const, content: PROMPT },
  ];
  const result = await client.chatMessages({ messages });
  assert.equal(result.message, 'Hello from KODEX');
  assert.equal(result.model, 'qwen2.5:1.5b');
  const payload = JSON.parse(captured.body) as {
    assistant: string;
    messages: unknown;
    message?: unknown;
    model?: unknown;
    tools?: unknown;
  };
  assert.equal(payload.assistant, 'kodex');
  assert.deepEqual(payload.messages, messages);
  assert.equal(payload.message, undefined);
  assert.equal(payload.model, undefined);
  assert.equal(payload.tools, undefined);
  assertLogsSafe(logs);
});

test('vision-only config cannot send workspace multi-turn chat', async () => {
  let called = false;
  const client = createKodexAiGatewayClient({
    config: enabledConfig(),
    fetchImpl: async () => {
      called = true;
      return jsonResponse(200, { reply: 'nope' });
    },
  });
  await assert.rejects(
    () =>
      client.chatMessages({
        messages: [
          { role: 'system', content: 'You are Kode AI.' },
          { role: 'user', content: PROMPT },
        ],
      }),
    KodexAiGatewayNotConfiguredError,
  );
  assert.equal(called, false);
});

test('error objects do not embed credentials or prompts', async () => {
  const client = clientWith(async () => jsonResponse(401, { token: TOKEN, prompt: PROMPT }));
  try {
    await client.chat({ message: PROMPT });
    assert.fail('expected auth error');
  } catch (error) {
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes(PROMPT), false);
    assert.equal((error as Error).message.includes(TOKEN), false);
  }
});
