import { ConflictError } from '../http/errors.js';
import type { ChatMessageRecord, ChatMessageType } from './store.js';

export type ClientMessagePayload = {
  body: string | null;
  messageType: ChatMessageType;
  replyToMessageId: string | null;
  attachmentUrl: string | null;
  attachmentName: string | null;
};

export function normalizeClientMessagePayload(input: {
  body?: string | null;
  messageType?: ChatMessageType | null;
  replyToMessageId?: string | null;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
}): ClientMessagePayload {
  const body = input.body?.trim() || null;
  return {
    body,
    messageType: input.messageType ?? 'text',
    replyToMessageId: input.replyToMessageId ?? null,
    attachmentUrl: input.attachmentUrl?.trim() || null,
    attachmentName: input.attachmentName?.trim() || null,
  };
}

export function clientMessagePayloadFromRecord(
  message: Pick<
    ChatMessageRecord,
    'body' | 'messageType' | 'replyToMessageId' | 'attachmentUrl' | 'attachmentName'
  >,
): ClientMessagePayload {
  return normalizeClientMessagePayload(message);
}

export function clientMessagePayloadsMatch(
  left: ClientMessagePayload,
  right: ClientMessagePayload,
): boolean {
  return (
    left.body === right.body &&
    left.messageType === right.messageType &&
    left.replyToMessageId === right.replyToMessageId &&
    left.attachmentUrl === right.attachmentUrl &&
    left.attachmentName === right.attachmentName
  );
}


export function assertClientMessageRetryAllowed(
  existing: ClientMessagePayload,
  incoming: ClientMessagePayload,
): void {
  if (clientMessagePayloadsMatch(existing, incoming)) return;
  throw new ConflictError(
    'CHAT_CLIENT_MESSAGE_CONFLICT',
    'This client message id was already used with different content.',
  );
}
