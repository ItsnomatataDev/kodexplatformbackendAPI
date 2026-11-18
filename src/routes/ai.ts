import { Hono, type Context } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { streamStoredMedia } from '../content/media-stream.js';
import type { FileStorage } from '../files/storage.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../http/errors.js';
import { llmChatCompletions } from '../kodex/llm-client.js';
import { requireProductOrg } from '../products/staff.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { PostgresAiStore } from '../ai/postgres-store.js';
import { readListQuery } from '../http/list-query.js';
import { resolveWorkspaceNavigation, type WorkspaceNavigation } from '../ai/navigation.js';
import { resolveTimeChat } from '../ai/time-actions.js';
import {
  AI_INFERENCE_HISTORY_LIMIT,
  coalesceAiThreadWork,
  shouldContinueLatestThread,
  shouldReusePendingUserTurn,
  trustedSystemPrompt,
  type InferenceChatMessage,
} from '../ai/conversation.js';
import { buildGatewayChatMessages } from '../ai/gateway-context.js';
import { createKodexAiGatewayClient } from '../ai-gateway/client.js';
import { isKodexAiWorkspaceGatewayConfigured } from '../ai-gateway/config.js';
import { logger } from '../config/logger.js';
import { messageContentForModel, resolveChatDocuments } from '../ai/document-text.js';
import { buildWorkspaceBrief, type WorkspaceSources } from '../ai/workspace-brief.js';
import { buildAgentInstructions, describePlan, preparePlan, stripThinking } from '../ai/agent/planner.js';
import {
  PLAN_TTL_MS,
  agentContext,
  cancelPlan,
  confirmPlan,
  getAgentRuntime,
  serializePlan,
  serializeScheduledAction,
  type AgentRuntime,
} from '../ai/agent/service.js';
import type { PlanStepRecord } from '../ai/agent/store.js';
import {
  compactHistory,
  memoryFromMetadata,
  planReplyIntent,
  quickTimeSteps,
  runAgentTurn,
  type ChatTurn,
} from '../ai/agent/turn.js';

export type WorkspaceGatewayChat = {
  enabled: boolean;
  chatMessages: (input: {
    messages: InferenceChatMessage[];
  }) => Promise<{ message: string }>;
};

export type AiRouteDependencies = {
  store: PostgresAiStore;
  files: FileStorage;
  workspace?: WorkspaceSources;
  agent?: AgentRuntime;
  llmChatCompletions?: typeof llmChatCompletions;
  workspaceGatewayChat?: WorkspaceGatewayChat;
};

function gatewayUnavailable(): never {
  throw new ServiceUnavailableError(
    'KODEX_AI_GATEWAY_NOT_CONFIGURED',
    'AI is temporarily unavailable. Please try again.',
  );
}

function defaultWorkspaceGatewayChat(): WorkspaceGatewayChat {
  const config = env.kodexAiGateway;
  if (!config.workspaceChatEnabled) {
    return { enabled: false, chatMessages: async () => gatewayUnavailable() };
  }
  if (!isKodexAiWorkspaceGatewayConfigured(config)) {
    return { enabled: true, chatMessages: async () => gatewayUnavailable() };
  }
  const client = createKodexAiGatewayClient({
    config,
    logger: (event) => {
      logger.info(
        {
          event: event.event,
          operation: event.operation,
          status: event.status,
          code: event.code,
        },
        'kodex ai gateway',
      );
    },
  });
  return {
    enabled: true,
    chatMessages: (input) => client.chatMessages(input),
  };
}

async function completeWithKodex(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  model: string | null,
  send: typeof llmChatCompletions = llmChatCompletions,
) {
  const data = await send({ model, messages });
  const choices = data.choices;
  const first = Array.isArray(choices) ? choices[0] : null;
  const msg = first && typeof first === 'object' ? (first as Record<string, unknown>).message : null;
  const content = msg && typeof msg === 'object' ? (msg as Record<string, unknown>).content : null;
  return typeof content === 'string' ? content : '';
}

function inferenceUnavailable(error: unknown): never {
  if (error instanceof AppError) throw error;
  logger.warn({ errName: error instanceof Error ? error.name : 'unknown' }, 'AI inference failed');
  throw new ServiceUnavailableError('AI_INFERENCE_UNAVAILABLE', 'AI is temporarily unavailable. Please try again.');
}

function pendingPlanId(history: Array<{ role: string; metadata: Record<string, unknown> }>) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role !== 'assistant') continue;
    const plan = item.metadata.kodexPlan;
    if (plan && typeof plan === 'object' && (plan as Record<string, unknown>).status === 'pending') {
      return String((plan as Record<string, unknown>).id);
    }
    return null;
  }
  return null;
}

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

function aiUploadObjectKey(params: {
  organizationId: string;
  userId: string;
  filename: string;
}) {
  const safeName = params.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return `ai/${params.organizationId}/${params.userId}/${Date.now()}-${safeName}`;
}

function aiMediaProxyUrl(objectKey: string) {
  return `/api/ai/media?key=${encodeURIComponent(objectKey)}`;
}

export function createAiRoutes(dependencies: AiRouteDependencies) {
  const routes = new Hono();
  const workspaceGateway = dependencies.workspaceGatewayChat ?? defaultWorkspaceGatewayChat();

  // --- Assistants ---

  routes.get('/assistants', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const page = await dependencies.store.listAssistants(
      organizationId,
      readListQuery(c),
    );
    return c.json({ assistants: page.assistants, hasMore: page.hasMore });
  });

  routes.post('/assistants', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const name = readRequiredText(body.name, 'name', 200);
    const assistant = await dependencies.store.createAssistant(
      organizationId,
      auth.actor.userId,
      {
        name,
        systemPrompt:
          readOptionalString(body.system_prompt ?? body.systemPrompt, 'systemPrompt', 20_000) ??
          '',
        model: readOptionalString(body.model, 'model', 120) ?? null,
        metadata:
          body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : {},
      },
    );
    return c.json({ assistant }, 201);
  });

  routes.get('/assistants/:assistantId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const assistantId = requireUuidValue(c.req.param('assistantId'), 'assistantId');
    return c.json({
      assistant: await dependencies.store.getAssistant(organizationId, assistantId),
    });
  });

  routes.patch('/assistants/:assistantId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const assistantId = requireUuidValue(c.req.param('assistantId'), 'assistantId');
    const body = await readJson(c);
    return c.json({
      assistant: await dependencies.store.updateAssistant(organizationId, assistantId, {
        name:
          body.name === undefined
            ? undefined
            : readRequiredText(body.name, 'name', 200),
        systemPrompt:
          body.system_prompt === undefined && body.systemPrompt === undefined
            ? undefined
            : (readOptionalString(
                body.system_prompt ?? body.systemPrompt,
                'systemPrompt',
                20_000,
              ) ?? ''),
        model:
          body.model === undefined
            ? undefined
            : (readOptionalString(body.model, 'model', 120) ?? null),
        metadata:
          body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      }),
    });
  });

  routes.delete('/assistants/:assistantId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const assistantId = requireUuidValue(c.req.param('assistantId'), 'assistantId');
    await dependencies.store.deleteAssistant(organizationId, assistantId);
    return c.body(null, 204);
  });

  // --- Projects ---

  routes.get('/projects', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const mine = c.req.query('mine') === 'true';
    const page = await dependencies.store.listProjects(
      organizationId,
      mine ? auth.actor.userId : null,
      readListQuery(c),
    );
    return c.json({ projects: page.projects, hasMore: page.hasMore });
  });

  routes.post('/projects', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const name = readRequiredText(body.name ?? body.title, 'name', 200);
    const project = await dependencies.store.createProject(
      organizationId,
      auth.actor.userId,
      {
        name,
        description:
          readOptionalString(body.description, 'description', 4000) ?? null,
        metadata:
          body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : {},
      },
    );
    return c.json({ project }, 201);
  });

  routes.get('/projects/:projectId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    return c.json({
      project: await dependencies.store.getProject(organizationId, projectId),
    });
  });

  routes.patch('/projects/:projectId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const body = await readJson(c);
    return c.json({
      project: await dependencies.store.updateProject(organizationId, projectId, {
        name:
          body.name === undefined && body.title === undefined
            ? undefined
            : readRequiredText(body.name ?? body.title, 'name', 200),
        description:
          body.description === undefined
            ? undefined
            : (readOptionalString(body.description, 'description', 4000) ?? null),
        metadata:
          body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : undefined,
      }),
    });
  });

  routes.delete('/projects/:projectId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    await dependencies.store.deleteProject(organizationId, projectId);
    return c.body(null, 204);
  });

  // --- Chat threads ---

  routes.get('/threads', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const limit = Number(c.req.query('limit') ?? 50);
    const offset = Number(c.req.query('offset') ?? 0);
    const result = await dependencies.store.listThreads(
      organizationId,
      auth.actor.userId,
      {
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      },
    );
    return c.json({
      threads: result.threads,
      conversations: result.threads,
      total: result.total,
      hasMore: result.total > offset + result.threads.length,
    });
  });

  routes.post('/threads', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const thread = await dependencies.store.createThread(
      organizationId,
      auth.actor.userId,
      {
        title: readOptionalString(body.title, 'title', 300) ?? undefined,
        assistantId: (body.assistantId ?? body.assistant_id ?? null) as string | null,
        projectId: (body.projectId ?? body.project_id ?? null) as string | null,
        metadata:
          body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? (body.metadata as Record<string, unknown>)
            : {},
      },
    );
    return c.json({ thread, conversation: thread }, 201);
  });

  routes.get('/threads/:threadId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    const thread = await dependencies.store.getThread(organizationId, auth.actor.userId, threadId);
    return c.json({ thread, conversation: thread });
  });

  routes.patch('/threads/:threadId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    const body = await readJson(c);
    const thread = await dependencies.store.updateThread(organizationId, auth.actor.userId, threadId, {
      title:
        body.title === undefined
          ? undefined
          : (readOptionalString(body.title, 'title', 300) ?? undefined),
      metadata:
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined,
      assistantId: (body.assistantId ?? body.assistant_id) as string | null | undefined,
      projectId: (body.projectId ?? body.project_id) as string | null | undefined,
    });
    return c.json({ thread, conversation: thread });
  });

  routes.delete('/threads/:threadId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    await dependencies.store.deleteThread(organizationId, auth.actor.userId, threadId);
    return c.body(null, 204);
  });

  routes.get('/threads/:threadId/messages', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    const limit = Number(c.req.query('limit') ?? 100);
    const messages = await dependencies.store.listMessages(organizationId, auth.actor.userId, threadId, {
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return c.json({ messages });
  });

  routes.post('/threads/:threadId/messages', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    const body = await readJson(c);
    const roleRaw = String(body.role ?? 'user').toLowerCase();
    if (roleRaw !== 'user') {
      throw new ValidationError('Only user messages can be created by the client.');
    }
    const content = readRequiredText(body.content, 'content', 50_000);
    const message = await dependencies.store.addMessage(organizationId, auth.actor.userId, threadId, {
      role: roleRaw,
      content,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      metadata:
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : {},
    });
    return c.json({ message }, 201);
  });

  // --- Assistant chat via KODEX LLM ---

  routes.post('/chat', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const message = readRequiredText(body.message, 'message', 50_000);
    let threadId = (body.threadId ?? body.conversationId ?? body.conversation_id ?? null) as
      | string
      | null;
    const assistantId = (body.assistantId ?? body.assistant_id ?? null) as string | null;

    let assistant = null as Awaited<ReturnType<PostgresAiStore['getAssistant']>> | null;
    if (assistantId) {
      assistant = await dependencies.store.getAssistant(organizationId, assistantId);
    }

    if (!threadId && shouldContinueLatestThread(threadId, body.newThread ?? body.new_thread)) {
      const latest = await dependencies.store.listThreads(organizationId, auth.actor.userId, {
        limit: 1,
      });
      threadId = latest.threads[0]?.id ?? null;
    }

    if (!threadId) {
      const thread = await dependencies.store.createThread(
        organizationId,
        auth.actor.userId,
        {
          title: message.slice(0, 80),
          assistantId: assistant?.id ?? null,
          projectId: (body.projectId ?? body.project_id ?? null) as string | null,
          metadata: {
            channel: body.channel ?? 'assistant',
          },
        },
      );
      threadId = thread.id;
    } else {
      await dependencies.store.getThread(organizationId, auth.actor.userId, threadId);
    }

    const requestMetadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    const clientMessageId =
      readOptionalString(body.clientMessageId ?? body.client_message_id, 'clientMessageId', 120) ?? null;
    const activeThreadId = threadId;

    const payload = await coalesceAiThreadWork(activeThreadId, `${clientMessageId ?? ''}\n${message}`, async () => {
      const threadId = activeThreadId;
      const recent = await dependencies.store.listMessages(organizationId, auth.actor.userId, threadId, {
        limit: AI_INFERENCE_HISTORY_LIMIT,
      });
      if (!shouldReusePendingUserTurn(recent, message, clientMessageId)) {
        const documents = await resolveChatDocuments({
          attachments: body.attachments,
          organizationId,
          userId: auth.actor.userId,
          bucket: env.minio.bucket,
          files: dependencies.files,
        });
        await dependencies.store.addMessage(organizationId, auth.actor.userId, threadId, {
          role: 'user',
          content: message,
          metadata: {
            ...requestMetadata,
            ...(clientMessageId ? { clientMessageId } : {}),
            ...(documents.length > 0 ? { documents } : {}),
          },
        });
      }

      const history = await dependencies.store.listMessages(organizationId, auth.actor.userId, threadId, {
        limit: AI_INFERENCE_HISTORY_LIMIT,
      });
      const workspaceFacts = dependencies.workspace
        ? await buildWorkspaceBrief(auth, dependencies.workspace)
        : '';
      const systemPrompt = [
        assistant?.system_prompt?.trim() ||
          'You are Kode AI, a helpful workplace assistant for the organization.',
        workspaceFacts,
      ].filter(Boolean).join('\n\n');

      const agent = dependencies.agent ?? getAgentRuntime();
      const complete = (
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        model: string | null,
      ) => completeWithKodex(messages, model, dependencies.llmChatCompletions);
      const respond = (
        reply: string,
        stored: { id: string; created_at: string | null; metadata: Record<string, unknown> },
        navigation: WorkspaceNavigation | null = null,
      ) => ({
        reply,
        navigation,
        conversationId: threadId,
        threadId,
        kodexPlan: stored.metadata.kodexPlan ?? null,
        assistantMessage: {
          id: stored.id,
          role: 'assistant' as const,
          content: reply,
          type: 'text',
          createdAt: stored.created_at,
          data: stored.metadata,
        },
      });

      const replyIntent = agent ? planReplyIntent(message) : null;
      const pendingId = replyIntent ? pendingPlanId(history) : null;
      if (agent && replyIntent && pendingId) {
        const decision = replyIntent === 'confirm'
          ? await confirmPlan(agent, auth, pendingId)
          : await cancelPlan(agent, auth, pendingId);
        if (decision && decision !== 'not_pending') {
          return respond(decision.reply, decision.message);
        }
      }

      let navigation: WorkspaceNavigation | null = null;
      const navigationResult = dependencies.workspace?.navigation
        ? await resolveWorkspaceNavigation(auth, message, dependencies.workspace.navigation)
        : null;
      const quickSteps = !navigationResult && agent ? quickTimeSteps(message) : null;
      const timeReply = !navigationResult && !quickSteps && dependencies.workspace?.time
        ? await resolveTimeChat(auth, message, dependencies.workspace.time, { readOnly: Boolean(agent) })
        : null;

      let reply: string;
      let planSteps: PlanStepRecord[] = [];
      if (navigationResult) {
        reply = navigationResult.reply;
        navigation = navigationResult.navigation;
    } else if (timeReply) {
      reply = timeReply;
    } else if (workspaceGateway.enabled) {
      try {
        const context = buildGatewayChatMessages({
          history,
          systemPrompt: trustedSystemPrompt(assistant?.system_prompt),
          currentUserMessage: message,
        });
        const result = await workspaceGateway.chatMessages({ messages: context.messages });
        reply = result.message.trim();
        if (!reply) throw new Error('empty_inference_reply');
      } catch (error) {
        inferenceUnavailable(error);
      }
    } else if (agent) {
        const ctx = agentContext(agent, auth);
        try {
          if (quickSteps) {
            const prepared = await preparePlan(ctx, quickSteps);
            planSteps = prepared.steps;
            reply = prepared.errors.length ? `${prepared.errors.join(' ')} Nothing was changed.` : '';
          } else {
            const thread = await dependencies.store.getThread(organizationId, auth.actor.userId, threadId);
            const { turns, earlierTopics } = compactHistory(
              history
                .filter((item) => item.role === 'user' || item.role === 'assistant')
                .filter((item) => item.content?.trim())
                .map((item): ChatTurn => ({
                  role: item.role as 'user' | 'assistant',
                  content: messageContentForModel(item.content, item.metadata),
                })),
            );
            const system = [
              systemPrompt,
              buildAgentInstructions(ctx, memoryFromMetadata(thread.metadata)),
              earlierTopics.length
                ? `Earlier in this chat the user also asked about:\n${earlierTopics.join('\n')}`
                : '',
            ].filter(Boolean).join('\n\n');
            const result = await runAgentTurn({
              ctx,
              system,
              turns,
              complete: (messages) => complete(messages, assistant?.model ?? null),
            });
            planSteps = result.errors.length ? [] : result.steps;
            reply = result.reply;
            if (result.errors.length) {
              reply = [reply, `I could not prepare that yet:\n${result.errors.map((error) => `- ${error}`).join('\n')}`]
                .filter(Boolean)
                .join('\n\n');
            }
          }
          if (planSteps.length > 0) {
            reply = [reply, `Here is what I will do once you confirm:\n${describePlan(planSteps)}`]
              .filter(Boolean)
              .join('\n\n');
          }
          reply = reply.trim();
          if (!reply) throw new Error('empty_inference_reply');
        } catch (error) {
          inferenceUnavailable(error);
        }
      } else {
        try {
          const content = await complete(
            [
              { role: 'system', content: systemPrompt },
              ...history
                .filter((item) => item.role === 'user' || item.role === 'assistant')
                .filter((item) => item.content?.trim())
                .map((item) => ({
                  role: item.role as 'user' | 'assistant',
                  content: messageContentForModel(item.content, item.metadata),
                })),
            ],
            assistant?.model ?? null,
          );
          reply = stripThinking(content);
          if (!reply) throw new Error('empty_inference_reply');
        } catch (error) {
          inferenceUnavailable(error);
        }
      }

      const plan = agent && planSteps.length > 0
        ? await agent.store.createPlan({
            organizationId,
            userId: auth.actor.userId,
            threadId,
            steps: planSteps,
            expiresAt: new Date(Date.now() + PLAN_TTL_MS),
          })
        : null;

      const assistantMessage = await dependencies.store.addMessage(
        organizationId,
        auth.actor.userId,
        threadId,
        {
          role: 'assistant',
          content: reply,
          metadata: {
            source: 'kodex',
            ...(navigation ? { navigation } : {}),
            ...(plan ? { kodexPlan: serializePlan(plan) } : {}),
          },
        },
      );
      if (plan && agent) {
        await agent.store.attachPlanMessage(plan.id, assistantMessage.id);
      }

      return respond(reply, assistantMessage, navigation);
    });
    return c.json(payload);
  });

  // --- KODEX actions ---

  const requireAgent = () => {
    const agent = dependencies.agent ?? getAgentRuntime();
    if (!agent) throw new ValidationError('KODEX actions are not available.');
    return agent;
  };

  const planDecision = (kind: 'confirm' | 'cancel') => async (c: Context) => {
    const auth = getAuth(c);
    authorize(auth);
    const agent = requireAgent();
    const planId = requireUuidValue(c.req.param('planId'), 'planId');
    const decision = kind === 'confirm'
      ? await confirmPlan(agent, auth, planId)
      : await cancelPlan(agent, auth, planId);
    if (!decision) throw new NotFoundError('KODEX_PLAN_NOT_FOUND', 'That KODEX request was not found.');
    if (decision === 'not_pending') {
      throw new ConflictError('KODEX_PLAN_NOT_PENDING', 'That request was already handled or has expired. Ask KODEX again.');
    }
    return c.json({
      plan: decision.plan,
      reply: decision.reply,
      assistantMessage: {
        id: decision.message.id,
        role: 'assistant' as const,
        content: decision.reply,
        type: 'text',
        createdAt: decision.message.created_at,
        data: decision.message.metadata,
      },
    });
  };

  routes.post('/plans/:planId/confirm', planDecision('confirm'));
  routes.post('/plans/:planId/cancel', planDecision('cancel'));

  routes.get('/scheduled', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const agent = requireAgent();
    const rows = await agent.store.listScheduledActions(organizationId, auth.actor.userId, {
      includeFinished: c.req.query('includeFinished') === 'true',
      limit: Number(c.req.query('limit') ?? 50) || 50,
    });
    return c.json({ scheduled: rows.map(serializeScheduledAction) });
  });

  routes.delete('/scheduled/:scheduledId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const agent = requireAgent();
    const id = requireUuidValue(c.req.param('scheduledId'), 'scheduledId');
    const result = await agent.store.cancelScheduledAction(organizationId, auth.actor.userId, id);
    if (!result) throw new NotFoundError('KODEX_SCHEDULED_NOT_FOUND', 'That scheduled task was not found.');
    if (result === 'not_scheduled') {
      throw new ConflictError('KODEX_SCHEDULED_NOT_PENDING', 'That task already ran or was cancelled.');
    }
    return c.json({ scheduled: serializeScheduledAction(result) });
  });

  // --- Uploads (MinIO) ---

  routes.post('/uploads/binary', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);

    const sizeHeader = c.req.header('content-length');
    const sizeBytes = Number(sizeHeader);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new ValidationError('Content-Length is required.');
    }
    if (sizeBytes > 25 * 1024 * 1024) {
      throw new ValidationError('File must be under 25 MiB.');
    }
    if (!c.req.raw.body) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }

    const filename =
      c.req.query('filename') ??
      c.req.header('x-kode-filename') ??
      'upload.bin';
    const contentType =
      c.req.header('content-type') ?? 'application/octet-stream';
    const objectKey = aiUploadObjectKey({
      organizationId,
      userId: auth.actor.userId,
      filename,
    });

    await dependencies.files.ensureBucket?.(env.minio.bucket);
    const put =
      dependencies.files.putObjectStream?.bind(dependencies.files) ??
      (async (input: {
        bucket: string;
        objectKey: string;
        body: ReadableStream<Uint8Array> | Buffer;
        contentType?: string | null;
        contentLength: number;
      }) => {
        const chunks: Uint8Array[] = [];
        if (Buffer.isBuffer(input.body)) {
          chunks.push(input.body);
        } else {
          const reader = input.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        }
        await dependencies.files.putObject({
          bucket: input.bucket,
          objectKey: input.objectKey,
          body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
          contentType: input.contentType,
        });
      });

    await put({
      bucket: env.minio.bucket,
      objectKey,
      body: c.req.raw.body,
      contentType,
      contentLength: sizeBytes,
    });

    const publicUrl = aiMediaProxyUrl(objectKey);
    return c.json(
      {
        url: publicUrl,
        public_url: publicUrl,
        file_path: objectKey,
        name: filename,
        size: sizeBytes,
        mimeType: contentType,
        metadata: {
          storage_bucket: env.minio.bucket,
          storage_path: objectKey,
        },
      },
      201,
    );
  });

  routes.get('/media', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const key = c.req.query('key');
    if (!key || !key.startsWith(`ai/${organizationId}/`)) {
      throw new ValidationError('Invalid media key.');
    }
    return streamStoredMedia({
      files: dependencies.files,
      bucket: env.minio.bucket,
      objectKey: key,
      rangeHeader: c.req.header('range'),
    });
  });

  return routes;
}
