export type KodexAiGatewayConfig = {
  /** Content Studio vision / existing analyze-media path. */
  enabled: boolean;
  /** AI Workspace `/api/ai/chat` Ubuntu multi-turn. Independent of `enabled`. */
  workspaceChatEnabled: boolean;
  baseUrl: string;
  token: string;
  chatTimeoutMs: number;
  analyzeTimeoutMs: number;
};

const FORBIDDEN_TOKENS = new Set(['local-development', 'local_development']);

function trimSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function booleanFromSource(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

function timeoutFromSource(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error(`${name} must be an integer between 1000 and 120000 milliseconds.`);
  }
  return parsed;
}

function assertHttpUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('KODEX_AI_GATEWAY_BASE_URL must be a valid http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('KODEX_AI_GATEWAY_BASE_URL must be a valid http(s) URL.');
  }
}

export function parseKodexAiGatewayConfig(
  source: NodeJS.Dict<string> = process.env,
): KodexAiGatewayConfig {
  const enabled = booleanFromSource(
    source.KODEX_AI_GATEWAY_ENABLED,
    false,
    'KODEX_AI_GATEWAY_ENABLED',
  );
  const workspaceChatEnabled = booleanFromSource(
    source.KODEX_AI_WORKSPACE_GATEWAY_ENABLED,
    false,
    'KODEX_AI_WORKSPACE_GATEWAY_ENABLED',
  );
  const baseUrl = trimSlash((source.KODEX_AI_GATEWAY_BASE_URL ?? '').trim());
  const token = (source.KODEX_AI_GATEWAY_TOKEN ?? '').trim();
  const chatTimeoutMs = timeoutFromSource(
    source.KODEX_AI_GATEWAY_TIMEOUT_MS,
    30_000,
    'KODEX_AI_GATEWAY_TIMEOUT_MS',
  );
  const analyzeTimeoutMs = timeoutFromSource(
    source.KODEX_AI_GATEWAY_ANALYZE_TIMEOUT_MS,
    60_000,
    'KODEX_AI_GATEWAY_ANALYZE_TIMEOUT_MS',
  );

  if (!enabled && !workspaceChatEnabled) {
    return {
      enabled: false,
      workspaceChatEnabled: false,
      baseUrl: '',
      token: '',
      chatTimeoutMs,
      analyzeTimeoutMs,
    };
  }

  if (!baseUrl) {
    throw new Error('KODEX_AI_GATEWAY_BASE_URL is required when the gateway is enabled.');
  }
  assertHttpUrl(baseUrl);
  if (!token) {
    throw new Error('KODEX_AI_GATEWAY_TOKEN is required when the gateway is enabled.');
  }
  if (FORBIDDEN_TOKENS.has(token.toLowerCase())) {
    throw new Error(
      'KODEX_AI_GATEWAY_TOKEN cannot be the broad local-development credential.',
    );
  }
  if (token.length < 16) {
    throw new Error('KODEX_AI_GATEWAY_TOKEN must be at least 16 characters.');
  }

  return {
    enabled,
    workspaceChatEnabled,
    baseUrl,
    token,
    chatTimeoutMs,
    analyzeTimeoutMs,
  };
}

export function isKodexAiGatewayConfigured(config: KodexAiGatewayConfig) {
  return config.enabled && Boolean(config.baseUrl) && Boolean(config.token);
}

export function isKodexAiWorkspaceGatewayConfigured(config: KodexAiGatewayConfig) {
  return (
    config.workspaceChatEnabled &&
    Boolean(config.baseUrl) &&
    Boolean(config.token)
  );
}
