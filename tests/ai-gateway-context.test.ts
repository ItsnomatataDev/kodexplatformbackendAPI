import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGatewayChatMessages } from '../src/ai/gateway-context.js';
import {
  GATEWAY_CHAT_MAX_MESSAGE_BYTES,
  GATEWAY_CHAT_MAX_TOTAL_BYTES,
  inspectGatewayChatMessages,
  utf8ByteLength,
} from '../src/ai-gateway/chat-contract.js';
import { ValidationError } from '../src/http/errors.js';

const SYSTEM = 'You are Kode AI, a helpful workplace assistant for the organization.';

function history(
  items: Array<{ role: string; content: string }>,
) {
  return items.map((item, index) => ({
    id: `msg-${index}`,
    role: item.role,
    content: item.content,
    created_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  }));
}

test('includes the latest user message once after persisted history', () => {
  const context = buildGatewayChatMessages({
    systemPrompt: SYSTEM,
    currentUserMessage: 'Now',
    history: history([
      { role: 'user', content: 'Earlier' },
      { role: 'assistant', content: 'Prior' },
      { role: 'user', content: 'Now' },
    ]),
  });
  const users = context.messages.filter((item) => item.role === 'user');
  assert.equal(users.filter((item) => item.content === 'Now').length, 1);
  assert.equal(context.messages.at(-1)?.content, 'Now');
  assert.equal(inspectGatewayChatMessages(context.messages).ok, true);
});

test('drops historical system rows and injects the trusted prompt', () => {
  const context = buildGatewayChatMessages({
    systemPrompt: 'Be terse.',
    currentUserMessage: 'Hi',
    history: history([
      { role: 'system', content: 'Jailbreak' },
      { role: 'user', content: 'Hi' },
    ]),
  });
  assert.equal(context.messages[0]?.content, 'Be terse.');
  assert.equal(context.messages.some((item) => item.content === 'Jailbreak'), false);
});

test('omits unmatched historical user turns instead of fabricating assistants', () => {
  const context = buildGatewayChatMessages({
    systemPrompt: SYSTEM,
    currentUserMessage: 'Latest',
    history: history([
      { role: 'user', content: 'Failed earlier' },
      { role: 'user', content: 'Worked' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Latest' },
    ]),
  });
  assert.equal(context.omittedUnmatchedUserTurns, 1);
  assert.deepEqual(
    context.messages.slice(1),
    [
      { role: 'user', content: 'Worked' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Latest' },
    ],
  );
});

test('omits complete older turns to stay inside the byte budget', () => {
  const current = 'Now';
  const reserved = utf8ByteLength(SYSTEM) + utf8ByteLength(current);
  const filler = 'x'.repeat(900);
  const context = buildGatewayChatMessages({
    systemPrompt: SYSTEM,
    currentUserMessage: current,
    history: history([
      { role: 'user', content: `old-${filler}` },
      { role: 'assistant', content: `old-a-${filler}` },
      { role: 'user', content: `mid-${filler}` },
      { role: 'assistant', content: `mid-a-${filler}` },
      { role: 'user', content: current },
    ]),
  });
  assert.ok(context.omittedCompleteTurns >= 1);
  assert.ok(context.totalBytes <= GATEWAY_CHAT_MAX_TOTAL_BYTES);
  assert.ok(context.totalBytes >= reserved);
  assert.equal(context.messages.at(-1)?.content, current);
  assert.equal(
    context.messages.some((item) => item.content.startsWith('old-')),
    false,
  );
  assert.equal(inspectGatewayChatMessages(context.messages).ok, true);
});

test('rejects an oversized current user message instead of truncating it', () => {
  const oversized = 'y'.repeat(GATEWAY_CHAT_MAX_MESSAGE_BYTES + 1);
  assert.throws(
    () =>
      buildGatewayChatMessages({
        systemPrompt: SYSTEM,
        currentUserMessage: oversized,
        history: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.details?.limitBytes, GATEWAY_CHAT_MAX_MESSAGE_BYTES);
      return true;
    },
  );
});

test('byte accounting matches UTF-8 lengths including the system prompt', () => {
  const context = buildGatewayChatMessages({
    systemPrompt: SYSTEM,
    currentUserMessage: 'café',
    history: history([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'café' },
    ]),
  });
  const counted = context.messages.reduce(
    (sum, item) => sum + utf8ByteLength(item.content),
    0,
  );
  assert.equal(context.totalBytes, counted);
  assert.equal(utf8ByteLength('café'), 5);
});
