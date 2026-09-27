/**
 * KODEX — platform AI gateway routes.
 *
 * Backed by an OpenAI-compatible LLM (company gateway via LLM_*).
 * CURSOR_API_KEY is reserved for Cursor Agents/SDK, not these chat/vision calls.
 */
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { requireOrganizationId } from '../authorization/organization.js';
import type { ChatMessageRecord, ChatStore } from '../chat/store.js';
import { chatEnvelope } from '../chat/events.js';
import { getChatRealtimeHub } from '../chat/hub.js';
import type { FileStorage } from '../files/storage.js';
import { readJson } from '../work/http.js';
import { runChatAssist } from '../kodex/chat-assist.js';
import {
  analyzeContentStudioMedia,
  generateContentStudioCaption,
} from '../kodex/content-studio.js';
import { isLlmReady } from '../kodex/llm-client.js';

export type KodexRouteDependencies = {
  files: FileStorage;
  chat: ChatStore;
};

function authorizeKodex(
  auth: ReturnType<typeof getAuth>,
  action: 'content_studio.read' | 'content_studio.manage',
) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: { type: 'content_studio', organizationId },
  });
  return organizationId;
}

function authorizeChatKodex(auth: ReturnType<typeof getAuth>) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action: 'chat.write',
    resource: { type: 'chat', organizationId },
  });
  return organizationId;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function serializeChatMessage(message: ChatMessageRecord) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    organizationId: message.organizationId,
    senderId: message.senderId,
    body: message.body,
    messageType: message.messageType,
    replyToMessageId: message.replyToMessageId,
    attachmentUrl: message.attachmentUrl,
    attachmentName: message.attachmentName,
    metadata: message.metadata,
    isEdited: message.isEdited,
    isDeleted: message.isDeleted,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    senderName: message.senderName ?? null,
    senderEmail: message.senderEmail ?? null,
  };
}

export function createKodexRoutes(dependencies: KodexRouteDependencies) {
  const routes = new Hono();
  const hub = getChatRealtimeHub();

  routes.get('/status', async (c) => {
    authorizeKodex(getAuth(c), 'content_studio.read');
    return c.json({
      name: 'KODEX',
      ready: isLlmReady(),
      providerHint: isLlmReady()
        ? 'openai-compatible'
        : 'Set LLM_API_KEY or OPENAI_API_KEY for the company KODEX gateway',
    });
  });

  routes.post('/chat-assist', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeChatKodex(auth);
    const body = await readJson(c);
    const result = await runChatAssist({
      store: dependencies.chat,
      auth,
      organizationId,
      input: {
        action: asOptionalString(body.action),
        conversationId: asOptionalString(body.conversationId) ?? null,
        message: asOptionalString(body.message),
        text: asOptionalString(body.text),
        rewriteMode: asOptionalString(body.rewriteMode),
      },
    });

    if (result.message) {
      const serialized = serializeChatMessage(result.message);
      await hub.publishToConversation(
        result.message.conversationId,
        chatEnvelope(
          'message.created',
          { message: serialized },
          {
            conversationId: result.message.conversationId,
            organizationId,
          },
        ),
      );
      return c.json({
        ok: true,
        reply: result.reply,
        message: serialized,
      });
    }

    return c.json({
      ok: true,
      rewrittenText: result.rewrittenText,
      reply: result.reply,
    });
  });

  routes.post('/content-studio/generate-caption', async (c) => {
    authorizeKodex(getAuth(c), 'content_studio.manage');
    const body = await readJson(c);
    const result = await generateContentStudioCaption({
      clientName: asOptionalString(body.clientName),
      postTitle: asOptionalString(body.postTitle),
      existingCaption: asOptionalString(body.existingCaption),
      mediaDescription: asOptionalString(body.mediaDescription),
      platform: asOptionalString(body.platform),
      tone: asOptionalString(body.tone),
      instruction: asOptionalString(body.instruction),
      websiteContext: asOptionalString(body.websiteContext),
      clientAiProfile:
        body.clientAiProfile && typeof body.clientAiProfile === 'object'
          ? (body.clientAiProfile as Record<string, string | undefined>)
          : null,
      captionExamples: Array.isArray(body.captionExamples)
        ? (body.captionExamples as Array<{
            caption?: string;
            outcome?: 'approved' | 'rejected';
            platform?: string;
            notes?: string;
          }>)
        : undefined,
    });
    return c.json(result);
  });

  routes.post('/content-studio/analyze-media', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeKodex(auth, 'content_studio.manage');
    const body = await readJson(c);
    const result = await analyzeContentStudioMedia({
      files: dependencies.files,
      organizationId,
      input: {
        clientName: asOptionalString(body.clientName),
        postTitle: asOptionalString(body.postTitle),
        existingCaption: asOptionalString(body.existingCaption),
        imageDataUrl: asOptionalString(body.imageDataUrl),
        imageUrl: asOptionalString(body.imageUrl ?? body.mediaUrl),
        storagePath: asOptionalString(body.storagePath),
        fileName: asOptionalString(body.fileName),
        websiteContext: asOptionalString(body.websiteContext),
        instruction: asOptionalString(body.instruction),
        platform: asOptionalString(body.platform),
        tone: asOptionalString(body.tone),
        clientAiProfile:
          body.clientAiProfile && typeof body.clientAiProfile === 'object'
            ? (body.clientAiProfile as Record<string, string | undefined>)
            : null,
      },
    });
    return c.json({
      ...result,
      suggestedCaption: result.generatedCaption,
      platformCaptions: {
        instagram: result.instagramCaption,
        facebook: result.facebookCaption,
      },
    });
  });

  return routes;
}
