import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getLlmConfig,
  llmChatText,
  prefersKodexOpenAi,
  resolveLlmModel,
} from '../src/kodex/llm-client.js';

const KEYS = [
  'KODEX_TOKEN',
  'KODEX_BASE_URL',
  'KODEX_CHAT_MODEL',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_CHAT_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_CHAT_MODEL',
] as const;

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();
  for (const key of KEYS) {
    previous.set(key, process.env[key]);
    const next = values[key];
    if (next == null) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  const finish = () => {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).finally(finish);
    }
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

test('KODEX_TOKEN and KODEX_BASE_URL win over other LLM credentials', () => {
  withEnv(
    {
      KODEX_TOKEN: 'kodex-test-token-value',
      KODEX_BASE_URL: 'https://ai-api.example.com/v1/',
      LLM_API_KEY: 'other-key-value-0001',
      LLM_BASE_URL: 'https://llm.internal/v1',
      OPENAI_API_KEY: 'sk-test-openai',
    },
    () => {
      const config = getLlmConfig();
      assert.equal(config.usingKodex, true);
      assert.equal(config.apiKey, 'kodex-test-token-value');
      assert.equal(config.baseUrl, 'https://ai-api.example.com/v1');
      assert.equal(config.chatModel, 'kodex');
      assert.equal(config.miniChatModel, 'kodex');
      assert.equal(prefersKodexOpenAi(config), true);
      assert.equal(resolveLlmModel('gpt-4o-mini', config), 'kodex');
      assert.equal(resolveLlmModel('harold', config), 'harold');
    },
  );
});

test('chat completions send the KODEX token as an OpenAI bearer token', async () => {
  const original = globalThis.fetch;
  let captured: { url: string; authorization: string; body: Record<string, unknown> } | null =
    null;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    captured = {
      url: String(input),
      authorization: headers.get('authorization') ?? '',
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    await withEnv(
      {
        KODEX_TOKEN: 'kodex-test-token-value',
        KODEX_BASE_URL: 'https://ai-api.example.com/v1',
        LLM_API_KEY: 'other-key-value-0001',
        LLM_BASE_URL: 'https://llm.internal/v1',
      },
      async () => {
        const reply = await llmChatText({
          systemPrompt: 'Reply with one word.',
          userMessage: 'Say pong.',
          model: 'gpt-4o',
        });
        assert.equal(reply, 'pong');
      },
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured?.url, 'https://ai-api.example.com/v1/chat/completions');
  assert.equal(captured?.authorization, 'Bearer kodex-test-token-value');
  assert.equal(captured?.body.model, 'kodex');
  assert.equal(captured?.body.stream, false);
});
