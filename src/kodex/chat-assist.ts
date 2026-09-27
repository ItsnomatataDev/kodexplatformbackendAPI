/**
 * Chat AI assist / rewrite via KODEX (OpenAI-compatible LLM).
 */
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../http/errors.js';
import type { AuthContext } from '../authorization/types.js';
import type { ChatMessageRecord, ChatStore } from '../chat/store.js';
import { isLlmReady, llmChatText } from './llm-client.js';

export type ChatAssistAction = 'assist' | 'rewrite';
export type ChatRewriteMode =
  | 'grammar'
  | 'shorter'
  | 'professional'
  | 'client_update';

export type ChatAssistInput = {
  action?: ChatAssistAction | string;
  conversationId?: string | null;
  message?: string | null;
  text?: string | null;
  rewriteMode?: ChatRewriteMode | string | null;
};

export type ChatAssistResult = {
  ok: true;
  reply?: string;
  rewrittenText?: string;
  message?: ChatMessageRecord;
};

function requireLlm() {
  if (!isLlmReady()) {
    throw new ServiceUnavailableError(
      'KODEX_NOT_CONFIGURED',
      'KODEX requires LLM_API_KEY (or OPENAI_API_KEY). Cursor API keys are for agents, not chat assist.',
    );
  }
}

function cleanKodexMention(value: string) {
  return value
    .replace(/(^|\s)@?kodex[:,]?\s*/i, ' ')
    .replace(/(^|\s)@?codex[:,]?\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkdownFence(value: string) {
  return value
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function rewriteModeInstruction(mode: string) {
  if (mode === 'shorter') {
    return 'Make the message shorter and clearer while preserving the meaning.';
  }
  if (mode === 'professional') {
    return 'Make the message professional, calm and clear for internal workplace chat.';
  }
  if (mode === 'client_update') {
    return 'Turn the message into a polished client-facing update without adding new facts.';
  }
  return 'Fix grammar, spelling, punctuation and clarity.';
}

function formatRecentMessage(message: ChatMessageRecord) {
  const sender =
    message.senderName?.trim() || message.senderEmail?.trim() || 'Team member';
  const body = (message.body ?? '').trim();
  const attachment = message.attachmentName
    ? ` [attachment: ${message.attachmentName}]`
    : '';
  return `${sender}: ${body || message.messageType}${attachment}`;
}

export async function runChatAssist(params: {
  store: ChatStore;
  auth: AuthContext;
  organizationId: string;
  input: ChatAssistInput;
}): Promise<ChatAssistResult> {
  requireLlm();

  const action = (params.input.action ?? 'assist').trim() || 'assist';
  const rawPrompt = String(
    params.input.message ?? params.input.text ?? '',
  ).trim();

  if (!rawPrompt) {
    throw new ValidationError('message or text is required.', {
      field: 'message',
    });
  }

  if (action === 'rewrite') {
    const rewriteMode = String(params.input.rewriteMode ?? 'grammar').trim();
    const rewrittenText = stripMarkdownFence(
      await llmChatText({
        systemPrompt: [
          'You rewrite internal team chat drafts.',
          rewriteModeInstruction(rewriteMode),
          "Keep the sender's meaning, tone and language style.",
          'Do not add new facts, promises, dates or names.',
          'Return only the rewritten message, with no explanation.',
        ].join('\n'),
        userMessage: rawPrompt,
        temperature: 0.2,
        maxTokens: 350,
      }),
    );

    return { ok: true, rewrittenText };
  }

  if (action !== 'assist') {
    throw new ValidationError('action must be "assist" or "rewrite".', {
      field: 'action',
    });
  }

  const conversationId = String(params.input.conversationId ?? '').trim();
  if (!conversationId) {
    throw new ValidationError('conversationId is required.', {
      field: 'conversationId',
    });
  }

  const conversation = await params.store.getConversation(
    params.organizationId,
    conversationId,
  );
  if (!conversation) {
    throw new NotFoundError(
      'CHAT_CONVERSATION_NOT_FOUND',
      'Conversation not found.',
    );
  }

  const isMember = await params.store.isMember(
    conversationId,
    params.auth.actor.userId,
  );
  if (!isMember) {
    throw new ForbiddenError(
      'CHAT_NOT_A_MEMBER',
      'You are not a member of this chat.',
    );
  }

  const recent = await params.store.listMessages({
    organizationId: params.organizationId,
    conversationId,
    limit: 30,
  });
  const recentLines = recent
    .filter((row) => !row.isDeleted)
    .map(formatRecentMessage);

  const userRequest = cleanKodexMention(rawPrompt) || rawPrompt;
  const conversationTitle = conversation.title?.trim() || 'Team chat';
  const role = params.auth.membership.roleKey ?? 'employee';
  const requesterName =
    params.auth.actor.email?.trim() || 'Workspace user';

  const reply = await llmChatText({
    systemPrompt: [
      "You are KODEX (also known as Codex) inside IT's No Matata team chat.",
      'You help the team turn chat into organized work.',
      'Be concise, practical, role-aware and warm.',
      'Use only the supplied chat context. Do not invent facts.',
      'If asked to create or change records, provide a clear preview instead of claiming it was done.',
      'Focus on summaries, decisions, blockers, owners, deadlines, draft replies and action items.',
      `Requester role: ${role}.`,
      `Requester name: ${requesterName}.`,
    ].join('\n'),
    userMessage: [
      `Conversation: ${conversationTitle}`,
      '',
      'Recent chat messages:',
      recentLines.length ? recentLines.join('\n') : 'No recent messages.',
      '',
      `User request: ${userRequest}`,
    ].join('\n'),
    temperature: 0.35,
    maxTokens: 900,
  });

  const disappearingSeconds = conversation.disappearingSeconds ?? null;
  const expiresAt =
    disappearingSeconds != null
      ? new Date(Date.now() + disappearingSeconds * 1000)
      : null;

  const message = await params.store.sendMessage({
    organizationId: params.organizationId,
    conversationId,
    senderId: params.auth.actor.userId,
    body: reply,
    messageType: 'text',
    metadata: {
      type: 'kodex_ai',
      source: 'chat_ai',
      trigger: 'mention',
      requestedBy: params.auth.actor.userId,
      originalMessage: rawPrompt,
    },
    expiresAt,
  });

  return { ok: true, reply, message };
}
