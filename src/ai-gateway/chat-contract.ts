export const GATEWAY_CHAT_ASSISTANT = 'kodex';
export const GATEWAY_CHAT_MAX_MESSAGES = 20;
export const GATEWAY_CHAT_MAX_MESSAGE_BYTES = 1024;
export const GATEWAY_CHAT_MAX_TOTAL_BYTES = 2048;

export type GatewayChatRole = 'system' | 'user' | 'assistant';

export type GatewayChatMessage = {
  role: GatewayChatRole;
  content: string;
};

export function utf8ByteLength(text: string) {
  return Buffer.byteLength(text, 'utf8');
}

export function inspectGatewayChatMessages(messages: unknown): {
  ok: true;
  messages: GatewayChatMessage[];
  totalBytes: number;
} | {
  ok: false;
  reason: string;
} {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: 'messages_required' };
  }
  if (messages.length > GATEWAY_CHAT_MAX_MESSAGES) {
    return { ok: false, reason: 'too_many_messages' };
  }

  const normalized: GatewayChatMessage[] = [];
  let totalBytes = 0;
  let systemCount = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const item = messages[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'invalid_message' };
    }
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { ok: false, reason: 'invalid_role' };
    }
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, reason: 'empty_content' };
    }
    if (role === 'system') {
      if (index !== 0 || systemCount > 0) {
        return { ok: false, reason: 'invalid_system' };
      }
      systemCount += 1;
    }
    const bytes = utf8ByteLength(content);
    if (bytes > GATEWAY_CHAT_MAX_MESSAGE_BYTES) {
      return { ok: false, reason: 'message_too_large' };
    }
    totalBytes += bytes;
    normalized.push({ role, content });
  }

  if (totalBytes > GATEWAY_CHAT_MAX_TOTAL_BYTES) {
    return { ok: false, reason: 'total_too_large' };
  }

  const dialogue = systemCount === 1 ? normalized.slice(1) : normalized;
  if (dialogue.length === 0 || dialogue[0]?.role !== 'user') {
    return { ok: false, reason: 'must_start_user' };
  }
  if (dialogue.at(-1)?.role !== 'user') {
    return { ok: false, reason: 'must_end_user' };
  }
  for (let index = 0; index < dialogue.length; index += 1) {
    const expected = index % 2 === 0 ? 'user' : 'assistant';
    if (dialogue[index]?.role !== expected) {
      return { ok: false, reason: 'invalid_alternation' };
    }
  }

  return { ok: true, messages: normalized, totalBytes };
}
