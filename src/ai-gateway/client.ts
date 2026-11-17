import {
  KodexAiGatewayAuthError,
  KodexAiGatewayForbiddenError,
  KodexAiGatewayInvalidResponseError,
  KodexAiGatewayNotConfiguredError,
  KodexAiGatewayOverloadedError,
  KodexAiGatewayTimeoutError,
  KodexAiGatewayUnavailableError,
} from './errors.js';
import {
  GATEWAY_CHAT_ASSISTANT,
  inspectGatewayChatMessages,
  type GatewayChatMessage,
} from './chat-contract.js';
import {
  isKodexAiGatewayConfigured,
  isKodexAiWorkspaceGatewayConfigured,
  type KodexAiGatewayConfig,
} from './config.js';
import {
  parseKodexAiAnalyzeResponse,
  type KodexAiAnalyzeResult,
  type ParseKodexAiAnalyzeOptions,
} from './vision-response.js';

export type { KodexAiAnalyzeResult } from './vision-response.js';

export type KodexAiGatewayLogEvent = {
  event:
    | 'kodex_ai_gateway_request'
    | 'kodex_ai_gateway_response'
    | 'kodex_ai_gateway_error';
  operation: 'chat' | 'analyze';
  status?: number;
  code?: string;
  fieldPath?: string;
};

export type KodexAiGatewayLogger = (event: KodexAiGatewayLogEvent) => void;

export type KodexAiChatInput = {
  message: string;
  assistant?: 'kodex' | string;
};

export type KodexAiChatMessagesInput = {
  messages: GatewayChatMessage[];
};

export type KodexAiChatResult = {
  assistant: string;
  message: string;
  model?: string | null;
};

export type KodexAiAnalyzeInput = {
  image: Buffer | Uint8Array;
  fileName?: string;
  contentType?: string;
};


export type KodexAiGatewayClientOptions = {
  config: KodexAiGatewayConfig;
  fetchImpl?: typeof fetch;
  logger?: KodexAiGatewayLogger;
};

const CHAT_PATH = '/api/v1/ai/chat';
const ANALYZE_PATH = '/api/v1/ai/media/analyze';
export const KODEX_AI_GATEWAY_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function nested(record: Record<string, unknown> | null, key: string) {
  return record ? asRecord(record[key]) : null;
}

function parseJsonBody(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new KodexAiGatewayInvalidResponseError(
      'The AI Gateway returned an invalid response.',
      { category: 'malformed_json' },
    );
  }
}

function extractChatResult(body: unknown): KodexAiChatResult {
  const record = asRecord(body);
  const data = nested(record, 'data') ?? nested(record, 'result');
  const message = firstString([
    record?.reply,
    data?.reply,
    record?.message,
    record?.text,
    record?.content,
    record?.output,
    data?.message,
    data?.text,
    data?.content,
  ]);
  if (!message) {
    throw new KodexAiGatewayInvalidResponseError(
      'The AI Gateway returned an invalid response.',
      { category: 'missing_field', fieldPath: 'reply' },
    );
  }
  const assistant = firstString([record?.assistant, data?.assistant]) || GATEWAY_CHAT_ASSISTANT;
  const model = firstString([record?.model, data?.model]) || null;
  return { assistant, message, model };
}


function mapStatus(status: number): never {
  if (status === 401) {
    throw new KodexAiGatewayAuthError();
  }
  if (status === 403) {
    throw new KodexAiGatewayForbiddenError();
  }
  if (status === 429) {
    throw new KodexAiGatewayOverloadedError();
  }
  if (status >= 500) {
    throw new KodexAiGatewayUnavailableError();
  }
  throw new KodexAiGatewayUnavailableError();
}

function isAbortError(error: unknown) {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

export function createKodexAiGatewayClient(options: KodexAiGatewayClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const emit = options.logger ?? (() => {});

  function requireTransport() {
    if (!options.config.baseUrl || !options.config.token) {
      throw new KodexAiGatewayNotConfiguredError();
    }
    return options.config;
  }

  async function send(
    operation: 'chat' | 'analyze',
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> {
    const config = requireTransport();
    emit({ event: 'kodex_ai_gateway_request', operation });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      if (!response.ok) {
        emit({
          event: 'kodex_ai_gateway_error',
          operation,
          status: response.status,
          code: `http_${response.status}`,
        });
        mapStatus(response.status);
      }
      const body = parseJsonBody(text);
      emit({
        event: 'kodex_ai_gateway_response',
        operation,
        status: response.status,
      });
      return body;
    } catch (error) {
      if (error instanceof KodexAiGatewayAuthError
        || error instanceof KodexAiGatewayForbiddenError
        || error instanceof KodexAiGatewayOverloadedError
        || error instanceof KodexAiGatewayUnavailableError
        || error instanceof KodexAiGatewayInvalidResponseError
        || error instanceof KodexAiGatewayNotConfiguredError) {
        if (error instanceof KodexAiGatewayInvalidResponseError) {
          emit({
            event: 'kodex_ai_gateway_error',
            operation,
            status: 200,
            code: error.details?.category ?? 'invalid_response',
            fieldPath: error.details?.fieldPath,
          });
        }
        throw error;
      }
      if (isAbortError(error)) {
        emit({
          event: 'kodex_ai_gateway_error',
          operation,
          code: 'timeout',
        });
        throw new KodexAiGatewayTimeoutError();
      }
      emit({
        event: 'kodex_ai_gateway_error',
        operation,
        code: 'network',
      });
      throw new KodexAiGatewayUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isConfigured() {
      return isKodexAiGatewayConfigured(options.config);
    },

    isWorkspaceChatConfigured() {
      return isKodexAiWorkspaceGatewayConfigured(options.config);
    },

    async chat(input: KodexAiChatInput): Promise<KodexAiChatResult> {
      if (!isKodexAiGatewayConfigured(options.config)) {
        throw new KodexAiGatewayNotConfiguredError();
      }
      const config = requireTransport();
      const message = input.message.trim();
      if (!message) {
        throw new KodexAiGatewayInvalidResponseError('Chat message is required.');
      }
      const body = await send(
        'chat',
        CHAT_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistant: input.assistant?.trim() || 'kodex',
            message,
          }),
        },
        config.chatTimeoutMs,
      );
      return extractChatResult(body);
    },

    async chatMessages(input: KodexAiChatMessagesInput): Promise<KodexAiChatResult> {
      if (!isKodexAiWorkspaceGatewayConfigured(options.config)) {
        throw new KodexAiGatewayNotConfiguredError();
      }
      const config = requireTransport();
      const inspected = inspectGatewayChatMessages(input.messages);
      if (!inspected.ok) {
        throw new KodexAiGatewayInvalidResponseError(
          'The AI Gateway chat payload is invalid.',
          { category: 'wrong_type', fieldPath: inspected.reason },
        );
      }
      const body = await send(
        'chat',
        CHAT_PATH,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assistant: GATEWAY_CHAT_ASSISTANT,
            messages: inspected.messages,
          }),
        },
        config.chatTimeoutMs,
      );
      return extractChatResult(body);
    },

    async analyzeImage(
      input: KodexAiAnalyzeInput,
      parseOptions?: ParseKodexAiAnalyzeOptions,
    ): Promise<KodexAiAnalyzeResult> {
      if (!isKodexAiGatewayConfigured(options.config)) {
        throw new KodexAiGatewayNotConfiguredError();
      }
      const config = requireTransport();
      const bytes = Buffer.from(input.image);
      if (bytes.length === 0) {
        throw new KodexAiGatewayInvalidResponseError('Image bytes are required.');
      }
      if (bytes.length > KODEX_AI_GATEWAY_MAX_IMAGE_BYTES) {
        throw new KodexAiGatewayInvalidResponseError('Image exceeds the 8 MiB gateway limit.');
      }
      const fileName = input.fileName?.trim() || 'image.png';
      const contentType = input.contentType?.trim() || 'image/png';
      const form = new FormData();
      form.append(
        'image',
        new Blob([new Uint8Array(bytes)], { type: contentType }),
        fileName,
      );
      const body = await send(
        'analyze',
        ANALYZE_PATH,
        { method: 'POST', body: form },
        config.analyzeTimeoutMs,
      );
      try {
        return parseKodexAiAnalyzeResponse(body, parseOptions);
      } catch (error) {
        if (error instanceof KodexAiGatewayInvalidResponseError) {
          emit({
            event: 'kodex_ai_gateway_error',
            operation: 'analyze',
            status: 200,
            code: error.details?.category ?? 'invalid_response',
            fieldPath: error.details?.fieldPath,
          });
        }
        throw error;
      }
    },
  };
}

export type KodexAiGatewayClient = ReturnType<typeof createKodexAiGatewayClient>;
