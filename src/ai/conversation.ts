export const AI_INFERENCE_HISTORY_LIMIT = 40;
export const AI_MESSAGE_PAGE_LIMIT = 100;
export const AI_MESSAGE_MAX_LIMIT = 500;

export type AiHistoryMessage = {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string | null;
};

export type InferenceChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

const DEFAULT_SYSTEM_PROMPT =
  'You are Kode AI, a helpful workplace assistant for the organization.';

export function trustedSystemPrompt(assistantPrompt?: string | null) {
  const trimmed = assistantPrompt?.trim();
  return trimmed || DEFAULT_SYSTEM_PROMPT;
}

export function clampMessageLimit(limit: number | undefined, fallback: number) {
  const value = Number.isFinite(limit) ? Number(limit) : fallback;
  return Math.min(Math.max(value, 1), AI_MESSAGE_MAX_LIMIT);
}

/**
 * Chronological latest-N. Equal timestamps sort by id so the order is stable.
 */
export function latestMessagesChronological<T extends AiHistoryMessage>(
  messages: T[],
  limit: number,
): T[] {
  const cap = clampMessageLimit(limit, AI_INFERENCE_HISTORY_LIMIT);
  return [...messages]
    .sort((left, right) => compareMessageOrder(left, right))
    .slice(-cap);
}

export function compareMessageOrder(left: AiHistoryMessage, right: AiHistoryMessage) {
  const leftAt = left.created_at ?? '';
  const rightAt = right.created_at ?? '';
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/**
 * DB `system` rows (including historical client inserts) never become the
 * trusted system prompt. Only user/assistant turns are forwarded.
 */
export function inferenceTurnsFromHistory(
  messages: AiHistoryMessage[],
  systemPrompt: string,
): InferenceChatMessage[] {
  const turns: InferenceChatMessage[] = [
    { role: 'system', content: trustedSystemPrompt(systemPrompt) },
  ];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    turns.push({ role: message.role, content });
  }
  return turns;
}

export function sameUserTurn(existing: AiHistoryMessage | undefined, content: string) {
  if (!existing || existing.role !== 'user') {
    return false;
  }
  return existing.content.trim() === content.trim();
}

function latestMessage(messages: AiHistoryMessage[]) {
  if (messages.length === 0) {
    return undefined;
  }
  return [...messages].sort(compareMessageOrder).at(-1);
}

function messageClientId(message: AiHistoryMessage) {
  const metadata = message.metadata ?? {};
  const value = metadata.clientMessageId ?? metadata.client_message_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function shouldReusePendingUserTurn(
  messages: AiHistoryMessage[],
  content: string,
  clientMessageId?: string | null,
) {
  const latest = latestMessage(messages);
  if (!latest || latest.role !== 'user') {
    return false;
  }
  const incomingId = clientMessageId?.trim() || null;
  if (incomingId) {
    return messageClientId(latest) === incomingId && sameUserTurn(latest, content);
  }
  return sameUserTurn(latest, content);
}

export function extractAssistantReply(data: unknown) {
  if (!data || typeof data !== 'object') {
    return '';
  }
  const choices = (data as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : null;
  const msg =
    first && typeof first === 'object'
      ? (first as Record<string, unknown>).message
      : null;
  const content =
    msg && typeof msg === 'object' ? (msg as Record<string, unknown>).content : null;
  return typeof content === 'string' ? content.trim() : '';
}

const threadLocks = new Map<string, Promise<unknown>>();
const inflightChats = new Map<string, { content: string; promise: Promise<unknown> }>();

export async function withAiThreadLock<T>(
  threadId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = threadLocks.get(threadId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  threadLocks.set(threadId, queued);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (threadLocks.get(threadId) === queued) {
      threadLocks.delete(threadId);
    }
  }
}

/**
 * Serializes work per thread. Concurrent identical payloads share one promise
 * so duplicate sends do not insert two user turns.
 */
export function coalesceAiThreadWork<T>(
  threadId: string,
  content: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = inflightChats.get(threadId);
  if (existing && existing.content === content) {
    return existing.promise as Promise<T>;
  }
  const promise = withAiThreadLock(threadId, work).finally(() => {
    const current = inflightChats.get(threadId);
    if (current?.promise === promise) {
      inflightChats.delete(threadId);
    }
  });
  inflightChats.set(threadId, { content, promise });
  return promise;
}
