/**
 * OpenAI-compatible LLM client for KODEX.
 *
 * Preferred company endpoint (Bearer token, same shape as OpenAI):
 *   KODEX_BASE_URL=https://ai-api.tmctechsolutions.com/v1
 *   KODEX_TOKEN=kodex_...
 *   model kodex or harold, stream false
 *
 * Other gateways:
 *   LLM_BASE_URL / LLM_API_KEY
 *   OPENAI_BASE_URL / OPENAI_API_KEY
 *
 * CURSOR_API_KEY (crsr_…) is for Cursor Agents / SDK — not KODEX chat/vision.
 */

import { TooManyRequestsError } from '../http/errors.js';

const KODEX_BUSY_STATUS = 429;
/** Kept well under the 120s browser timeout so a queued request still has time to run. */
export const KODEX_DEFAULT_BUSY_WAIT_MS = 45_000;

type BusyWaitOptions = {
  busyWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function busyRetryDelayMs(response: Response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 3000;
}

/** The gateway has one shared inference slot; wait for capacity instead of failing the user. */
async function sendWaitingForCapacity(
  send: () => Promise<Response>,
  options: BusyWaitOptions = {},
) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.busyWaitMs ?? KODEX_DEFAULT_BUSY_WAIT_MS);
  for (;;) {
    const response = await send();
    if (response.status !== KODEX_BUSY_STATUS) return response;
    const delay = busyRetryDelayMs(response);
    await response.body?.cancel().catch(() => undefined);
    if (Date.now() + delay > deadline) {
      throw new TooManyRequestsError(
        Math.ceil(delay / 1000),
        'KODEX AI is busy with other requests right now. Please try again in a minute.',
      );
    }
    await sleep(delay);
  }
}

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: unknown;
  name?: string;
};

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  usingInternal: boolean;
  usingKodex: boolean;
  chatModel: string;
  miniChatModel: string;
};

const KODEX_MODELS = new Set(['kodex', 'harold']);

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || '';
}

export function getLlmConfig(): LlmConfig {
  const kodexBase = optionalEnv('KODEX_BASE_URL');
  const kodexToken = optionalEnv('KODEX_TOKEN');
  const internalBase = optionalEnv('LLM_BASE_URL');
  const openaiBase = optionalEnv('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
  const usingKodex = Boolean(kodexBase && kodexToken);
  const apiKey = usingKodex
    ? kodexToken
    : optionalEnv('LLM_API_KEY') || optionalEnv('OPENAI_API_KEY');
  const usingInternal = usingKodex || Boolean(internalBase);
  const kodexModel = optionalEnv('KODEX_CHAT_MODEL');
  const chatModel = usingKodex
    ? KODEX_MODELS.has(kodexModel)
      ? kodexModel
      : 'kodex'
    : optionalEnv('LLM_CHAT_MODEL') || optionalEnv('OPENAI_CHAT_MODEL') || 'gpt-4o-mini';
  const miniChatModel = usingKodex
    ? chatModel
    : optionalEnv('LLM_CHAT_MINI_MODEL') ||
      optionalEnv('OPENAI_CHAT_MODEL') ||
      optionalEnv('LLM_CHAT_MODEL') ||
      'gpt-4o-mini';

  return {
    baseUrl: trimSlash(kodexBase || internalBase || openaiBase),
    apiKey,
    usingInternal,
    usingKodex,
    chatModel,
    miniChatModel,
  };
}

export function prefersKodexOpenAi(config = getLlmConfig()) {
  return config.usingKodex && Boolean(config.apiKey) && Boolean(config.baseUrl);
}

export function resolveLlmModel(requested: string | null | undefined, config = getLlmConfig()) {
  const value = requested?.trim() || config.miniChatModel;
  if (config.usingKodex && !KODEX_MODELS.has(value)) {
    return config.chatModel;
  }
  return value;
}

export function isLlmReady(config = getLlmConfig()) {
  return Boolean(config.apiKey);
}

export function assertLlmConfigured(config = getLlmConfig()) {
  if (!config.apiKey) {
    throw new Error(
      'KODEX is not configured. Set KODEX_TOKEN and KODEX_BASE_URL for the company LLM.',
    );
  }
  return config;
}

async function llmFetch(path: string, body: Record<string, unknown>) {
  const config = assertLlmConfigured();
  const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const payload = JSON.stringify(body);
  const response = await sendWaitingForCapacity(() =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: payload,
    }),
  );

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
    model: resolveLlmModel(params.model, config),
    messages: params.messages,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    stream: false,
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

export function kodexMediaAnalyzeUrl(baseUrl: string) {
  return `${new URL(baseUrl).origin}/api/v1/ai/media/analyze`;
}

export type KodexImageAnalysis = {
  description: string;
  mood: string;
  mainSubject: string;
  summary: string;
};

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item)).filter(Boolean).join(', ');
  }
  return '';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readKodexImageAnalysis(body: unknown): KodexImageAnalysis {
  const root = recordValue(body) ?? {};
  const analysis = recordValue(root.analysis) ?? root;
  const description =
    textValue(analysis.description) ||
    textValue(analysis.sceneDescription) ||
    textValue(analysis.summary);
  const mood = textValue(analysis.mood);
  const mainSubject = textValue(analysis.mainSubject) || textValue(analysis.subject);
  const summary = [
    mainSubject ? `Subject: ${mainSubject}` : '',
    description ? `Description: ${description}` : '',
    mood ? `Mood: ${mood}` : '',
  ].filter(Boolean).join('\n');
  return {
    description: description || summary,
    mood,
    mainSubject,
    summary: summary || description,
  };
}

/** Content Studio image reading. Chat completions reject image parts. */
export async function kodexAnalyzeImage(params: {
  bytes: Buffer;
  fileName?: string;
  contentType?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
} & BusyWaitOptions): Promise<KodexImageAnalysis> {
  const config = assertLlmConfigured();
  if (!config.usingKodex) {
    throw new Error('KODEX image analysis requires KODEX_TOKEN and KODEX_BASE_URL.');
  }
  const form = new FormData();
  const contentType = params.contentType?.trim() || 'image/png';
  form.append(
    'image',
    new Blob([new Uint8Array(params.bytes)], { type: contentType }),
    params.fileName?.trim() || 'image.png',
  );
  const response = await sendWaitingForCapacity(
    () =>
      (params.fetchImpl ?? fetch)(kodexMediaAnalyzeUrl(config.baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
      }),
    params,
  );
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(`KODEX vision error (${response.status}).`);
  }
  const analysis = readKodexImageAnalysis(data);
  if (!analysis.summary) {
    throw new Error('KODEX vision returned no image description.');
  }
  return analysis;
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
