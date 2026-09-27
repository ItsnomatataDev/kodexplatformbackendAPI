export const CHAT_CONVERSATION_TYPES = [
  'direct',
  'group',
  'department',
  'announcement',
] as const;

export const CHAT_MESSAGE_TYPES = [
  'text',
  'image',
  'audio',
  'file',
  'system',
] as const;

export type ChatConversationType = (typeof CHAT_CONVERSATION_TYPES)[number];
export type ChatMessageType = (typeof CHAT_MESSAGE_TYPES)[number];
export type ChatMemberRole = 'owner' | 'admin' | 'member';

export type ChatConversationRecord = {
  id: string;
  organizationId: string;
  officeId: string | null;
  title: string | null;
  type: ChatConversationType;
  createdBy: string;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  unreadCount?: number;
  memberCount?: number;
  disappearingSeconds?: number | null;
};

export type ChatMemberRecord = {
  id: string;
  conversationId: string;
  userId: string;
  role: ChatMemberRole;
  joinedAt: Date;
  isMuted: boolean;
  lastReadMessageId: string | null;
  lastReadAt: Date | null;
  fullName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
};

export type ChatMessageRecord = {
  id: string;
  conversationId: string;
  organizationId: string;
  senderId: string;
  body: string | null;
  messageType: ChatMessageType;
  replyToMessageId: string | null;
  attachmentUrl: string | null;
  attachmentName: string | null;
  metadata: Record<string, unknown>;
  isEdited: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  senderName?: string | null;
  senderEmail?: string | null;
  expiresAt?: Date | null;
  reactions?: ChatReactionRecord[];
};

export type ChatReactionRecord = {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
};

export type ChatUserKeyMaterialRecord = {
  userId: string;
  organizationId: string;
  keyFingerprint: string;
  publicWrapKey: string;
  keyVersion: number;
  updatedAt: Date;
};

export type ChatConversationKeyEnvelopeRecord = {
  id: string;
  organizationId: string;
  conversationId: string;
  userId: string;
  wrappedKey: string;
  keyVersion: number;
  updatedAt: Date;
};

export type ListConversationsInput = {
  organizationId: string;
  userId: string;
  limit?: number;
  offset?: number;
};

export type ListMessagesInput = {
  organizationId: string;
  conversationId: string;
  limit?: number;
  before?: Date | null;
};

export type SendMessageInput = {
  organizationId: string;
  conversationId: string;
  senderId: string;
  body?: string | null;
  messageType?: ChatMessageType;
  replyToMessageId?: string | null;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
};

export type CreateDirectConversationInput = {
  organizationId: string;
  createdBy: string;
  otherUserId: string;
  officeId?: string | null;
};

export type CreateGroupConversationInput = {
  organizationId: string;
  createdBy: string;
  title: string;
  memberUserIds: string[];
  officeId?: string | null;
};

export interface ChatStore {
  listConversations(
    input: ListConversationsInput,
  ): Promise<{ conversations: ChatConversationRecord[]; hasMore: boolean }>;
  getConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<ChatConversationRecord | null>;
  listMembers(
    conversationId: string,
  ): Promise<ChatMemberRecord[]>;
  isMember(
    conversationId: string,
    userId: string,
  ): Promise<boolean>;
  findOrCreateDirect(
    input: CreateDirectConversationInput,
  ): Promise<ChatConversationRecord>;
  createGroup(
    input: CreateGroupConversationInput,
  ): Promise<ChatConversationRecord>;
  listMessages(input: ListMessagesInput): Promise<ChatMessageRecord[]>;
  getMessage(
    organizationId: string,
    messageId: string,
  ): Promise<ChatMessageRecord | null>;
  sendMessage(input: SendMessageInput): Promise<ChatMessageRecord>;
  editMessage(input: {
    organizationId: string;
    messageId: string;
    senderId: string;
    body: string;
  }): Promise<ChatMessageRecord>;
  softDeleteMessage(input: {
    organizationId: string;
    messageId: string;
    actorUserId: string;
    allowAny?: boolean;
  }): Promise<ChatMessageRecord>;
  markRead(input: {
    conversationId: string;
    userId: string;
    messageId: string;
  }): Promise<ChatMemberRecord>;
  listReactions(messageId: string): Promise<ChatReactionRecord[]>;
  listReactionsForMessages(messageIds: string[]): Promise<ChatReactionRecord[]>;
  toggleReaction(input: {
    messageId: string;
    userId: string;
    emoji: string;
  }): Promise<{ added: boolean; reaction: ChatReactionRecord | null }>;
  leaveConversation(input: {
    conversationId: string;
    userId: string;
  }): Promise<boolean>;
  updateDisappearingSeconds(input: {
    organizationId: string;
    conversationId: string;
    seconds: number | null;
  }): Promise<ChatConversationRecord>;
  blockUser(input: {
    organizationId: string;
    blockerId: string;
    blockedId: string;
    conversationId?: string | null;
  }): Promise<void>;
  unblockUser(input: {
    organizationId: string;
    blockerId: string;
    blockedId: string;
  }): Promise<void>;
  listBlockedUserIds(input: {
    organizationId: string;
    blockerId: string;
  }): Promise<string[]>;
  isEitherBlocked(input: {
    organizationId: string;
    userA: string;
    userB: string;
  }): Promise<boolean>;
  upsertUserKeyMaterial(input: {
    organizationId: string;
    userId: string;
    keyFingerprint: string;
    publicWrapKey: string;
    keyVersion?: number;
  }): Promise<ChatUserKeyMaterialRecord>;
  getUserKeyMaterial(input: {
    organizationId: string;
    userId: string;
  }): Promise<ChatUserKeyMaterialRecord | null>;
  listPeerWrapKeys(input: {
    organizationId: string;
    conversationId: string;
    requesterUserId: string;
  }): Promise<Array<{ userId: string; publicWrapKey: string; keyVersion: number }>>;
  upsertConversationKeyEnvelope(input: {
    organizationId: string;
    conversationId: string;
    actorUserId: string;
    targetUserId: string;
    wrappedKey: string;
    keyVersion?: number;
  }): Promise<ChatConversationKeyEnvelopeRecord>;
  getOwnConversationKeyEnvelope(input: {
    organizationId: string;
    conversationId: string;
    userId: string;
    keyVersion?: number;
  }): Promise<ChatConversationKeyEnvelopeRecord | null>;
}
