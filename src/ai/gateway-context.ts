import {
  GATEWAY_CHAT_MAX_MESSAGE_BYTES,
  GATEWAY_CHAT_MAX_MESSAGES,
  GATEWAY_CHAT_MAX_TOTAL_BYTES,
  utf8ByteLength,
} from '../ai-gateway/chat-contract.js';
import { ValidationError } from '../http/errors.js';
import {
  type AiHistoryMessage,
  type InferenceChatMessage,
  latestMessagesChronological,
  AI_INFERENCE_HISTORY_LIMIT,
} from './conversation.js';

export type GatewayChatContext = {
  messages: InferenceChatMessage[];
  totalBytes: number;
  omittedCompleteTurns: number;
  omittedUnmatchedUserTurns: number;
};

type CompleteTurn = {
  user: string;
  assistant: string;
};

/**
 * Ubuntu chat budget is 2,048 UTF-8 bytes for the whole `messages[]` payload,
 * including the trusted system prompt. After a typical KODEX system prompt
 * (~70 bytes) and the current user turn, remaining history is often only one
 * or two short complete turns. The 20-message cap is usually not the limiter.
 */
export function buildGatewayChatMessages(params: {
  history: AiHistoryMessage[];
  systemPrompt: string;
  currentUserMessage: string;
}): GatewayChatContext {
  const systemPrompt = params.systemPrompt.trim();
  const currentUserMessage = params.currentUserMessage.trim();
  if (!systemPrompt) {
    throw new ValidationError('A trusted system prompt is required.');
  }
  if (!currentUserMessage) {
    throw new ValidationError('message is required.');
  }

  const systemBytes = utf8ByteLength(systemPrompt);
  const currentBytes = utf8ByteLength(currentUserMessage);
  if (systemBytes > GATEWAY_CHAT_MAX_MESSAGE_BYTES) {
    throw new ValidationError(
      'The trusted system prompt exceeds the AI Gateway message size limit.',
      { limitBytes: GATEWAY_CHAT_MAX_MESSAGE_BYTES, actualBytes: systemBytes },
    );
  }
  if (currentBytes > GATEWAY_CHAT_MAX_MESSAGE_BYTES) {
    throw new ValidationError(
      'The current message exceeds the AI Gateway message size limit.',
      { limitBytes: GATEWAY_CHAT_MAX_MESSAGE_BYTES, actualBytes: currentBytes },
    );
  }

  const reserved = systemBytes + currentBytes;
  if (reserved > GATEWAY_CHAT_MAX_TOTAL_BYTES) {
    throw new ValidationError(
      'The current message and system prompt exceed the AI Gateway context budget.',
      { limitBytes: GATEWAY_CHAT_MAX_TOTAL_BYTES, actualBytes: reserved },
    );
  }

  const chronological = latestMessagesChronological(
    params.history,
    AI_INFERENCE_HISTORY_LIMIT,
  );
  const { pairs, omittedUnmatchedUserTurns } = completeTurnsFromHistory(
    chronological,
    currentUserMessage,
  );

  let kept = [...pairs];
  let omittedCompleteTurns = 0;
  while (kept.length > 0) {
    const oversizedIndex = kept.findIndex((pair) => !pairFitsMessageLimit(pair));
    if (oversizedIndex >= 0) {
      omittedCompleteTurns += oversizedIndex + 1;
      kept = kept.slice(oversizedIndex + 1);
      continue;
    }
    if (suffixFits(kept, reserved)) {
      break;
    }
    kept.shift();
    omittedCompleteTurns += 1;
  }

  const totalBytes =
    reserved + kept.reduce((sum, pair) => sum + utf8ByteLength(pair.user) + utf8ByteLength(pair.assistant), 0);

  const messages: InferenceChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];
  for (const pair of kept) {
    messages.push({ role: 'user', content: pair.user });
    messages.push({ role: 'assistant', content: pair.assistant });
  }
  messages.push({ role: 'user', content: currentUserMessage });

  return {
    messages,
    totalBytes,
    omittedCompleteTurns,
    omittedUnmatchedUserTurns,
  };
}

function pairFitsMessageLimit(pair: CompleteTurn) {
  return (
    utf8ByteLength(pair.user) <= GATEWAY_CHAT_MAX_MESSAGE_BYTES
    && utf8ByteLength(pair.assistant) <= GATEWAY_CHAT_MAX_MESSAGE_BYTES
  );
}

function suffixFits(pairs: CompleteTurn[], reservedBytes: number) {
  const historyBytes = pairs.reduce(
    (sum, pair) => sum + utf8ByteLength(pair.user) + utf8ByteLength(pair.assistant),
    0,
  );
  const messageCount = 2 + pairs.length * 2;
  return (
    messageCount <= GATEWAY_CHAT_MAX_MESSAGES
    && reservedBytes + historyBytes <= GATEWAY_CHAT_MAX_TOTAL_BYTES
  );
}

function completeTurnsFromHistory(
  history: AiHistoryMessage[],
  currentUserMessage: string,
) {
  const dialogue = history.filter((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return false;
    }
    return Boolean(message.content.trim());
  });

  let items = dialogue;
  const last = items.at(-1);
  if (last?.role === 'user' && last.content.trim() === currentUserMessage) {
    items = items.slice(0, -1);
  }

  const pairs: CompleteTurn[] = [];
  let pendingUser: string | null = null;
  let omittedUnmatchedUserTurns = 0;

  for (const item of items) {
    if (item.role === 'user') {
      if (pendingUser) {
        omittedUnmatchedUserTurns += 1;
      }
      pendingUser = item.content.trim();
      continue;
    }
    if (pendingUser) {
      pairs.push({
        user: pendingUser,
        assistant: item.content.trim(),
      });
      pendingUser = null;
      continue;
    }
  }
  if (pendingUser) {
    omittedUnmatchedUserTurns += 1;
  }

  return { pairs, omittedUnmatchedUserTurns };
}
