import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatEnvelope, conversationChannel } from '../src/chat/events.js';
import { ChatRealtimeHub } from '../src/chat/hub.js';

test('chat envelope shapes realtime frames', () => {
  const envelope = chatEnvelope(
    'message.created',
    { hello: true },
    { conversationId: 'c1', organizationId: 'o1' },
  );
  assert.equal(envelope.type, 'message.created');
  assert.equal(envelope.conversationId, 'c1');
  assert.equal(envelope.organizationId, 'o1');
  assert.equal(envelope.payload.hello, true);
  assert.ok(envelope.at);
});

test('conversation channel naming is stable', () => {
  assert.equal(conversationChannel('abc'), 'chat:conversation:abc');
});

test('hub delivers locally without Redis', async () => {
  const hub = new ChatRealtimeHub();
  const sent: string[] = [];
  hub.register('conn-1', {
    socket: { send: (data) => sent.push(data) },
    userId: 'u1',
    organizationId: 'o1',
    conversations: new Set(['c1']),
  });

  await hub.publishToConversation(
    'c1',
    chatEnvelope('typing', { userId: 'u2', isTyping: true }, {
      conversationId: 'c1',
      organizationId: 'o1',
    }),
  );

  assert.equal(sent.length, 1);
  const parsed = JSON.parse(sent[0]!) as { type: string };
  assert.equal(parsed.type, 'typing');
  hub.unregister('conn-1');
  await hub.stop();
});
