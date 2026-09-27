import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { env } from '../config/env.js';
import { streamStoredMedia } from '../content/media-stream.js';
import type { FileStorage } from '../files/storage.js';
import { ValidationError } from '../http/errors.js';
import { llmChatCompletions, llmChatText } from '../kodex/llm-client.js';
import { requireProductOrg } from '../products/staff.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { PostgresAiStore } from '../ai/postgres-store.js';
import { readListQuery } from '../http/list-query.js';

export type AiRouteDependencies = {
  store: PostgresAiStore;
  files: FileStorage;
};

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
    const thread = await dependencies.store.getThread(organizationId, threadId);
    return c.json({ thread, conversation: thread });
  });

  routes.patch('/threads/:threadId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    const body = await readJson(c);
    const thread = await dependencies.store.updateThread(organizationId, threadId, {
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
    await dependencies.store.deleteThread(organizationId, threadId);
    return c.body(null, 204);
  });

  routes.get('/threads/:threadId/messages', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    const limit = Number(c.req.query('limit') ?? 100);
    const messages = await dependencies.store.listMessages(organizationId, threadId, {
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return c.json({ messages });
  });

  routes.post('/threads/:threadId/messages', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const threadId = requireUuidValue(c.req.param('threadId'), 'threadId');
    const body = await readJson(c);
    const roleRaw = String(body.role ?? 'user');
    if (roleRaw !== 'user' && roleRaw !== 'assistant' && roleRaw !== 'system') {
      throw new ValidationError('role must be user, assistant, or system.');
    }
    const content = readRequiredText(body.content, 'content', 50_000);
    const message = await dependencies.store.addMessage(organizationId, threadId, {
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
      await dependencies.store.getThread(organizationId, threadId);
    }

    await dependencies.store.addMessage(organizationId, threadId, {
      role: 'user',
      content: message,
      metadata:
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : {},
    });

    const history = await dependencies.store.listMessages(organizationId, threadId, {
      limit: 40,
    });
    const systemPrompt =
      assistant?.system_prompt?.trim() ||
      'You are Kode AI, a helpful workplace assistant for the organization.';

    let reply: string;
    try {
      if (history.length > 2) {
        const data = await llmChatCompletions({
          model: assistant?.model ?? null,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.map((item) => ({
              role: item.role,
              content: item.content,
            })),
          ],
        });
        const choices = data.choices;
        const first = Array.isArray(choices) ? choices[0] : null;
        const msg =
          first && typeof first === 'object'
            ? (first as Record<string, unknown>).message
            : null;
        const content =
          msg && typeof msg === 'object'
            ? (msg as Record<string, unknown>).content
            : null;
        reply =
          (typeof content === 'string' ? content : '').trim() ||
          'No response generated.';
      } else {
        reply = await llmChatText({
          systemPrompt,
          userMessage: message,
          model: assistant?.model ?? null,
        });
      }
    } catch (error) {
      reply =
        error instanceof Error
          ? `AI is unavailable right now: ${error.message}`
          : 'AI is unavailable right now.';
    }

    const assistantMessage = await dependencies.store.addMessage(
      organizationId,
      threadId,
      {
        role: 'assistant',
        content: reply,
        metadata: { source: 'kodex' },
      },
    );

    return c.json({
      reply,
      conversationId: threadId,
      threadId,
      assistantMessage: {
        id: assistantMessage.id,
        role: 'assistant' as const,
        content: reply,
        type: 'text',
        createdAt: assistantMessage.created_at,
        data: assistantMessage.metadata,
      },
    });
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
