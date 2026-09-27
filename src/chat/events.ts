export type ChatRealtimeEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'reaction.added'
  | 'reaction.removed'
  | 'typing'
  | 'read_receipt'
  | 'presence'
  | 'ping'
  | 'pong'
  | 'subscribe'
  | 'unsubscribe'
  | 'error';

export type ChatRealtimeEnvelope = {
  type: ChatRealtimeEventType;
  conversationId?: string;
  organizationId?: string;
  payload: Record<string, unknown>;
  at: string;
};

export function chatEnvelope(
  type: ChatRealtimeEventType,
  payload: Record<string, unknown>,
  meta?: { conversationId?: string; organizationId?: string },
): ChatRealtimeEnvelope {
  return {
    type,
    conversationId: meta?.conversationId,
    organizationId: meta?.organizationId,
    payload,
    at: new Date().toISOString(),
  };
}

export function conversationChannel(conversationId: string) {
  return `chat:conversation:${conversationId}`;
}

export function organizationPresenceChannel(organizationId: string) {
  return `chat:presence:${organizationId}`;
}
