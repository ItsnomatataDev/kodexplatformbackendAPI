import { keysetPredicate, listLimit, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

function iso(v: unknown) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mapAssistant(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    name: String(row.name),
    system_prompt: String(row.system_prompt ?? ''),
    model: row.model == null ? null : String(row.model),
    metadata: asRecord(row.metadata),
    created_by: row.created_by == null ? null : String(row.created_by),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function mapProject(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    user_id: row.user_id == null ? null : String(row.user_id),
    name: String(row.name),
    title: String(row.name),
    description: row.description == null ? null : String(row.description),
    metadata: asRecord(row.metadata),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function mapThread(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    user_id: String(row.user_id),
    assistant_id: row.assistant_id == null ? null : String(row.assistant_id),
    project_id: row.project_id == null ? null : String(row.project_id),
    title: String(row.title ?? 'New chat'),
    metadata: asRecord(row.metadata),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function mapMessage(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    thread_id: String(row.thread_id),
    conversation_id: String(row.thread_id),
    role: String(row.role),
    content: String(row.content ?? ''),
    attachments: asArray(row.attachments),
    metadata: asRecord(row.metadata),
    created_at: iso(row.created_at),
  };
}

function mapFlow(row: Record<string, unknown>) {
  const definition = asRecord(row.definition);
  const enabled = Boolean(row.enabled);
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    name: String(row.name),
    definition,
    enabled,
    created_by: row.created_by == null ? null : String(row.created_by),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
   
    project_id:
      definition.project_id == null && definition.projectId == null
        ? null
        : String(definition.project_id ?? definition.projectId),
    slug:
      definition.slug == null
        ? String(row.name)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
        : String(definition.slug),
    description:
      definition.description == null ? null : String(definition.description),
    webhook_url:
      definition.webhook_url == null && definition.webhookUrl == null
        ? null
        : String(definition.webhook_url ?? definition.webhookUrl),
    status: enabled
      ? String(definition.status ?? 'active')
      : String(definition.status ?? 'disabled'),
  };
}

function mapRun(row: Record<string, unknown>) {
  const result = row.result == null ? null : asRecord(row.result);
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    flow_id: String(row.flow_id),
    automation_flow_id: String(row.flow_id),
    status: String(row.status),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    result,
    error: row.error == null ? null : String(row.error),
    created_at: iso(row.created_at),
  
    project_id:
      result?.project_id == null && result?.projectId == null
        ? null
        : String(result?.project_id ?? result?.projectId),
    workflow_name:
      result?.workflow_name == null && result?.workflowName == null
        ? null
        : String(result?.workflow_name ?? result?.workflowName),
    message:
      result?.message == null
        ? row.error == null
          ? null
          : String(row.error)
        : String(result.message),
    triggered_by:
      result?.triggered_by == null && result?.triggeredBy == null
        ? null
        : String(result?.triggered_by ?? result?.triggeredBy),
  };
}

export class PostgresAiStore {

  async listAssistants(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT * FROM ai.assistants
       WHERE organization_id = $1
         ${cursor}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map((row) => mapAssistant(row)), limit);
    return { assistants: paged.rows, hasMore: paged.hasMore };
  }

  async getAssistant(organizationId: string, assistantId: string) {
    const result = await db.query(
      `SELECT * FROM ai.assistants
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, assistantId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('AI_ASSISTANT_NOT_FOUND', 'Assistant not found.');
    }
    return mapAssistant(row);
  }

  async createAssistant(
    organizationId: string,
    userId: string,
    input: {
      name: string;
      systemPrompt?: string;
      model?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const result = await db.query(
      `INSERT INTO ai.assistants (
         organization_id, name, system_prompt, model, metadata, created_by
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [
        organizationId,
        input.name,
        input.systemPrompt ?? '',
        input.model ?? null,
        JSON.stringify(input.metadata ?? {}),
        userId,
      ],
    );
    return mapAssistant(result.rows[0]);
  }

  async updateAssistant(
    organizationId: string,
    assistantId: string,
    patch: {
      name?: string;
      systemPrompt?: string;
      model?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const current = await this.getAssistant(organizationId, assistantId);
    const result = await db.query(
      `UPDATE ai.assistants SET
         name = $3,
         system_prompt = $4,
         model = $5,
         metadata = $6::jsonb,
         updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        assistantId,
        patch.name ?? current.name,
        patch.systemPrompt ?? current.system_prompt,
        patch.model === undefined ? current.model : patch.model,
        JSON.stringify(patch.metadata ?? current.metadata),
      ],
    );
    return mapAssistant(result.rows[0]);
  }

  async deleteAssistant(organizationId: string, assistantId: string) {
    const result = await db.query(
      `DELETE FROM ai.assistants
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [organizationId, assistantId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('AI_ASSISTANT_NOT_FOUND', 'Assistant not found.');
    }
  }

  async listProjects(
    organizationId: string,
    userId?: string | null,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    let userFilter = '';
    if (userId) {
      params.push(userId);
      userFilter = `AND (user_id = $${params.length} OR user_id IS NULL)`;
    }
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'updated_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT * FROM ai.projects
       WHERE organization_id = $1 ${userFilter}
         ${cursor}
       ORDER BY updated_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map((row) => mapProject(row)), limit);
    return { projects: paged.rows, hasMore: paged.hasMore };
  }

  async getProject(organizationId: string, projectId: string) {
    const result = await db.query(
      `SELECT * FROM ai.projects
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, projectId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('AI_PROJECT_NOT_FOUND', 'Project not found.');
    }
    return mapProject(row);
  }

  async createProject(
    organizationId: string,
    userId: string,
    input: {
      name: string;
      description?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const result = await db.query(
      `INSERT INTO ai.projects (
         organization_id, user_id, name, description, metadata
       ) VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [
        organizationId,
        userId,
        input.name,
        input.description ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapProject(result.rows[0]);
  }

  async updateProject(
    organizationId: string,
    projectId: string,
    patch: {
      name?: string;
      description?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const current = await this.getProject(organizationId, projectId);
    const result = await db.query(
      `UPDATE ai.projects SET
         name = $3,
         description = $4,
         metadata = $5::jsonb,
         updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        projectId,
        patch.name ?? current.name,
        patch.description === undefined ? current.description : patch.description,
        JSON.stringify(patch.metadata ?? current.metadata),
      ],
    );
    return mapProject(result.rows[0]);
  }

  async deleteProject(organizationId: string, projectId: string) {
    const result = await db.query(
      `DELETE FROM ai.projects
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [organizationId, projectId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('AI_PROJECT_NOT_FOUND', 'Project not found.');
    }
  }

  async listThreads(
    organizationId: string,
    userId: string,
    options?: { limit?: number; offset?: number },
  ) {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const offset = Math.max(options?.offset ?? 0, 0);
    const result = await db.query(
      `SELECT * FROM ai.chat_threads
       WHERE organization_id = $1 AND user_id = $2
       ORDER BY updated_at DESC
       LIMIT $3 OFFSET $4`,
      [organizationId, userId, limit, offset],
    );
    const countResult = await db.query(
      `SELECT count(*)::int AS total FROM ai.chat_threads
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    return {
      threads: result.rows.map((row) => mapThread(row)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async getThread(organizationId: string, threadId: string) {
    const result = await db.query(
      `SELECT * FROM ai.chat_threads
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, threadId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('AI_THREAD_NOT_FOUND', 'Chat thread not found.');
    }
    return mapThread(row);
  }

  async createThread(
    organizationId: string,
    userId: string,
    input: {
      title?: string;
      assistantId?: string | null;
      projectId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const result = await db.query(
      `INSERT INTO ai.chat_threads (
         organization_id, user_id, assistant_id, project_id, title, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        organizationId,
        userId,
        input.assistantId ?? null,
        input.projectId ?? null,
        input.title?.trim() || 'New chat',
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return mapThread(result.rows[0]);
  }

  async updateThread(
    organizationId: string,
    threadId: string,
    patch: {
      title?: string;
      metadata?: Record<string, unknown>;
      assistantId?: string | null;
      projectId?: string | null;
    },
  ) {
    const current = await this.getThread(organizationId, threadId);
    const result = await db.query(
      `UPDATE ai.chat_threads SET
         title = $3,
         metadata = $4::jsonb,
         assistant_id = $5,
         project_id = $6,
         updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        threadId,
        patch.title ?? current.title,
        JSON.stringify(patch.metadata ?? current.metadata),
        patch.assistantId === undefined
          ? current.assistant_id
          : patch.assistantId,
        patch.projectId === undefined ? current.project_id : patch.projectId,
      ],
    );
    return mapThread(result.rows[0]);
  }

  async deleteThread(organizationId: string, threadId: string) {
    const result = await db.query(
      `DELETE FROM ai.chat_threads
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [organizationId, threadId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('AI_THREAD_NOT_FOUND', 'Chat thread not found.');
    }
  }

  async listMessages(
    organizationId: string,
    threadId: string,
    options?: { limit?: number },
  ) {
    await this.getThread(organizationId, threadId);
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const result = await db.query(
      `SELECT * FROM ai.chat_messages
       WHERE organization_id = $1 AND thread_id = $2
       ORDER BY created_at ASC
       LIMIT $3`,
      [organizationId, threadId, limit],
    );
    return result.rows.map((row) => mapMessage(row));
  }

  async addMessage(
    organizationId: string,
    threadId: string,
    input: {
      role: 'user' | 'assistant' | 'system';
      content: string;
      attachments?: unknown[];
      metadata?: Record<string, unknown>;
    },
  ) {
    await this.getThread(organizationId, threadId);
    const result = await db.query(
      `INSERT INTO ai.chat_messages (
         organization_id, thread_id, role, content, attachments, metadata
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       RETURNING *`,
      [
        organizationId,
        threadId,
        input.role,
        input.content,
        JSON.stringify(input.attachments ?? []),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    await db.query(
      `UPDATE ai.chat_threads SET updated_at = NOW()
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, threadId],
    );
    return mapMessage(result.rows[0]);
  }


  async listFlows(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT * FROM ai.automation_flows
       WHERE organization_id = $1
         ${cursor}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map((row) => mapFlow(row)), limit);
    return { flows: paged.rows, hasMore: paged.hasMore };
  }

  async getFlow(organizationId: string, flowId: string) {
    const result = await db.query(
      `SELECT * FROM ai.automation_flows
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, flowId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('AUTOMATION_FLOW_NOT_FOUND', 'Automation flow not found.');
    }
    return mapFlow(row);
  }

  async createFlow(
    organizationId: string,
    userId: string,
    input: {
      name: string;
      definition?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) {
    const result = await db.query(
      `INSERT INTO ai.automation_flows (
         organization_id, name, definition, enabled, created_by
       ) VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING *`,
      [
        organizationId,
        input.name,
        JSON.stringify(input.definition ?? {}),
        input.enabled ?? true,
        userId,
      ],
    );
    return mapFlow(result.rows[0]);
  }

  async updateFlow(
    organizationId: string,
    flowId: string,
    patch: {
      name?: string;
      definition?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) {
    const current = await this.getFlow(organizationId, flowId);
    const nextDefinition = patch.definition
      ? { ...current.definition, ...patch.definition }
      : current.definition;
    const result = await db.query(
      `UPDATE ai.automation_flows SET
         name = $3,
         definition = $4::jsonb,
         enabled = $5,
         updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        flowId,
        patch.name ?? current.name,
        JSON.stringify(nextDefinition),
        patch.enabled ?? current.enabled,
      ],
    );
    return mapFlow(result.rows[0]);
  }

  async deleteFlow(organizationId: string, flowId: string) {
    const result = await db.query(
      `DELETE FROM ai.automation_flows
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [organizationId, flowId],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('AUTOMATION_FLOW_NOT_FOUND', 'Automation flow not found.');
    }
  }

  async listRuns(
    organizationId: string,
    flowId?: string | null,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    let flowFilter = '';
    if (flowId) {
      params.push(flowId);
      flowFilter = `AND flow_id = $${params.length}`;
    }
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT * FROM ai.automation_runs
       WHERE organization_id = $1 ${flowFilter}
         ${cursor}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map((row) => mapRun(row)), limit);
    return { runs: paged.rows, hasMore: paged.hasMore };
  }

  async getRun(organizationId: string, runId: string) {
    const result = await db.query(
      `SELECT * FROM ai.automation_runs
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, runId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundError('AUTOMATION_RUN_NOT_FOUND', 'Automation run not found.');
    }
    return mapRun(row);
  }

  async startRun(
    organizationId: string,
    userId: string,
    flowId: string,
    input?: { payload?: Record<string, unknown> },
  ) {
    const flow = await this.getFlow(organizationId, flowId);
    if (!flow.enabled) {
      throw new ValidationError('Automation flow is disabled.');
    }

    const startedAt = new Date();
    const insert = await db.query(
      `INSERT INTO ai.automation_runs (
         organization_id, flow_id, status, started_at, result
       ) VALUES ($1, $2, 'pending', $3, $4::jsonb)
       RETURNING *`,
      [
        organizationId,
        flowId,
        startedAt.toISOString(),
        JSON.stringify({
          workflow_name: flow.name,
          project_id: flow.project_id,
          triggered_by: userId,
          message: 'Run accepted (stub engine).',
          payload: input?.payload ?? {},
        }),
      ],
    );

    const runId = String(insert.rows[0].id);
    const finishedAt = new Date();
    const complete = await db.query(
      `UPDATE ai.automation_runs SET
         status = 'completed',
         finished_at = $3,
         result = COALESCE(result, '{}'::jsonb) || $4::jsonb
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        runId,
        finishedAt.toISOString(),
        JSON.stringify({
          message: 'Stub run completed — no workflow engine wired yet.',
          stub: true,
        }),
      ],
    );
    return mapRun(complete.rows[0]);
  }
}
