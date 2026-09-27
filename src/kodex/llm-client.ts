/**
 * OpenAI-compatible LLM client for KODEX.
 *
 * Prefer the company / internal gateway when ready:
 *   LLM_BASE_URL=https://llm.internal/v1
 *   LLM_API_KEY=...
 *
 * Falls back to OpenAI during cutover:
 *   OPENAI_API_KEY / OPENAI_BASE_URL
 *
 * CURSOR_API_KEY (crsr_…) is for Cursor Agents / SDK — not KODEX chat/vision.
 */

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: unknown;
  name?: string;
};

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  usingInternal: boolean;
  chatModel: string;
  miniChatModel: string;
};

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || '';
}

export function getLlmConfig(): LlmConfig {
  const internalBase = optionalEnv('LLM_BASE_URL');
  const openaiBase = optionalEnv('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
  const apiKey = optionalEnv('LLM_API_KEY') || optionalEnv('OPENAI_API_KEY');
  const usingInternal = Boolean(internalBase);

  return {
    baseUrl: trimSlash(internalBase || openaiBase),
    apiKey,
    usingInternal,
    chatModel:
      optionalEnv('LLM_CHAT_MODEL') ||
      optionalEnv('OPENAI_CHAT_MODEL') ||
      'gpt-4o-mini',
    miniChatModel:
      optionalEnv('LLM_CHAT_MINI_MODEL') ||
      optionalEnv('OPENAI_CHAT_MODEL') ||
      optionalEnv('LLM_CHAT_MODEL') ||
      'gpt-4o-mini',
  };
}

export function isLlmReady(config = getLlmConfig()) {
  return Boolean(config.apiKey);
}

export function assertLlmConfigured(config = getLlmConfig()) {
  if (!config.apiKey) {
    throw new Error(
      'KODEX is not configured. Set LLM_API_KEY (preferred) or OPENAI_API_KEY for the company LLM gateway.',
    );
  }
  return config;
}

async function llmFetch(path: string, body: Record<string, unknown>) {
  const config = assertLlmConfigured();
  const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const nested =
      record?.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : null;
    const message =
      (typeof nested?.message === 'string' && nested.message) ||
      (typeof record?.message === 'string' && record.message) ||
      text ||
      `LLM API error (${response.status})`;
    throw new Error(
      `${config.usingInternal ? 'Internal LLM' : 'OpenAI'} error (${response.status}): ${message}`,
    );
  }

  return data as Record<string, unknown>;
}

export async function llmChatCompletions(params: {
  messages: LlmMessage[];
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: unknown;
}) {
  const config = getLlmConfig();
  return llmFetch('/chat/completions', {
    model: params.model?.trim() || config.miniChatModel,
    messages: params.messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
  });
}

export async function llmChatText(params: {
  systemPrompt: string;
  userMessage: string;
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const data = await llmChatCompletions({
    model: params.model,
    temperature: params.temperature ?? 0.7,
    maxTokens: params.maxTokens ?? 2048,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userMessage },
    ],
  });
  const choices = data.choices;
  if (!Array.isArray(choices) || !choices[0]) {
    return 'No response generated.';
  }
  const message = (choices[0] as Record<string, unknown>).message;
  const content =
    message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : null;
  return (typeof content === 'string' ? content : '').trim() || 'No response generated.';
}

/** Vision via chat completions (portable across OpenAI-compatible gateways). */
export async function llmVisionText(params: {
  prompt: string;
  imageDataUrl: string;
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const data = await llmChatCompletions({
    model: params.model,
    temperature: params.temperature ?? 0.5,
    maxTokens: params.maxTokens ?? 1200,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: params.prompt },
          { type: 'image_url', image_url: { url: params.imageDataUrl } },
        ],
      },
    ],
  });
  const choices = data.choices;
  if (!Array.isArray(choices) || !choices[0]) {
    return 'No response generated.';
  }
  const message = (choices[0] as Record<string, unknown>).message;
  const content =
    message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : null;
  return (typeof content === 'string' ? content : '').trim() || 'No response generated.';
}
