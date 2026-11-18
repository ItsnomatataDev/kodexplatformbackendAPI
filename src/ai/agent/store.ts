import { randomUUID } from 'node:crypto';
import { db } from '../../db/pool.js';

export type PlanStepRecord = {
  id: string;
  action: string;
  args: Record<string, unknown>;
  summary: string;
  runAt: string | null;
};

export type PlanStepResult = {
  id: string;
  status: 'done' | 'failed' | 'scheduled' | 'skipped';
  summary: string;
  ref?: string | null;
  scheduledActionId?: string | null;
};

export type PlanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

export type AgentPlanRecord = {
  id: string;
  organizationId: string;
  userId: string;
  threadId: string;
  messageId: string | null;
  status: PlanStatus;
  steps: PlanStepRecord[];
  results: PlanStepResult[];
  expiresAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
};

export type ScheduledActionStatus = 'scheduled' | 'running' | 'done' | 'failed' | 'cancelled';

export type ScheduledActionRecord = {
  id: string;
  organizationId: string;
  userId: string;
  threadId: string | null;
  planId: string | null;
  action: string;
  args: Record<string, unknown>;
  summary: string;
  runAt: Date;
  status: ScheduledActionStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export type CreateScheduledActionInput = {
  organizationId: string;
  userId: string;
  threadId: string | null;
  planId: string | null;
  action: string;
  args: Record<string, unknown>;
  summary: string;
  runAt: Date;
};

export interface AgentStore {
  createPlan(input: {
    organizationId: string;
    userId: string;
    threadId: string;
    steps: PlanStepRecord[];
    expiresAt: Date;
  }): Promise<AgentPlanRecord>;
  attachPlanMessage(planId: string, messageId: string): Promise<void>;
  getPlan(organizationId: string, userId: string, planId: string): Promise<AgentPlanRecord | null>;
  /** Moves a pending, unexpired plan to `status`; null when it was not pending. */
  claimPlan(organizationId: string, userId: string, planId: string, status: 'running' | 'cancelled'): Promise<AgentPlanRecord | null>;
  finishPlan(planId: string, status: 'completed' | 'failed', results: PlanStepResult[]): Promise<void>;
  createScheduledAction(input: CreateScheduledActionInput): Promise<ScheduledActionRecord>;
  listScheduledActions(organizationId: string, userId: string, options?: { includeFinished?: boolean; limit?: number }): Promise<ScheduledActionRecord[]>;
  cancelScheduledAction(organizationId: string, userId: string, id: string): Promise<ScheduledActionRecord | 'not_scheduled' | null>;
  claimDueScheduledActions(now: Date, limit: number): Promise<ScheduledActionRecord[]>;
  finishScheduledAction(id: string, status: 'done' | 'failed', outcome: { result?: Record<string, unknown> | null; error?: string | null }): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mapPlan(row: Record<string, unknown>): AgentPlanRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    userId: String(row.user_id),
    threadId: String(row.thread_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    status: row.status as PlanStatus,
    steps: Array.isArray(row.steps) ? (row.steps as PlanStepRecord[]) : [],
    results: Array.isArray(row.results) ? (row.results as PlanStepResult[]) : [],
    expiresAt: new Date(row.expires_at as string),
    decidedAt: row.decided_at ? new Date(row.decided_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

function mapScheduled(row: Record<string, unknown>): ScheduledActionRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    userId: String(row.user_id),
    threadId: row.thread_id == null ? null : String(row.thread_id),
    planId: row.plan_id == null ? null : String(row.plan_id),
    action: String(row.action),
    args: record(row.args),
    summary: String(row.summary),
    runAt: new Date(row.run_at as string),
    status: row.status as ScheduledActionStatus,
    result: row.result ? record(row.result) : null,
    error: row.error == null ? null : String(row.error),
    finishedAt: row.finished_at ? new Date(row.finished_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

export class PostgresAgentStore implements AgentStore {
  async createPlan(input: Parameters<AgentStore['createPlan']>[0]) {
    const result = await db.query(
      `INSERT INTO ai.agent_plans (organization_id, user_id, thread_id, steps, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [input.organizationId, input.userId, input.threadId, JSON.stringify(input.steps), input.expiresAt],
    );
    return mapPlan(result.rows[0]);
  }

  async attachPlanMessage(planId: string, messageId: string) {
    await db.query(
      `UPDATE ai.agent_plans SET message_id = $2, updated_at = NOW() WHERE id = $1`,
      [planId, messageId],
    );
  }

  async getPlan(organizationId: string, userId: string, planId: string) {
    const result = await db.query(
      `SELECT * FROM ai.agent_plans WHERE organization_id = $1 AND user_id = $2 AND id = $3`,
      [organizationId, userId, planId],
    );
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  async claimPlan(organizationId: string, userId: string, planId: string, status: 'running' | 'cancelled') {
    const result = await db.query(
      `UPDATE ai.agent_plans
       SET status = $4, decided_at = NOW(), updated_at = NOW()
       WHERE organization_id = $1 AND user_id = $2 AND id = $3
         AND status = 'pending' AND expires_at > NOW()
       RETURNING *`,
      [organizationId, userId, planId, status],
    );
    return result.rows[0] ? mapPlan(result.rows[0]) : null;
  }

  async finishPlan(planId: string, status: 'completed' | 'failed', results: PlanStepResult[]) {
    await db.query(
      `UPDATE ai.agent_plans SET status = $2, results = $3::jsonb, updated_at = NOW() WHERE id = $1`,
      [planId, status, JSON.stringify(results)],
    );
  }

  async createScheduledAction(input: CreateScheduledActionInput) {
    const result = await db.query(
      `INSERT INTO ai.scheduled_actions
         (organization_id, user_id, thread_id, plan_id, action, args, summary, run_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [
        input.organizationId,
        input.userId,
        input.threadId,
        input.planId,
        input.action,
        JSON.stringify(input.args),
        input.summary,
        input.runAt,
      ],
    );
    return mapScheduled(result.rows[0]);
  }

  async listScheduledActions(organizationId: string, userId: string, options: { includeFinished?: boolean; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const result = await db.query(
      `SELECT * FROM ai.scheduled_actions
       WHERE organization_id = $1 AND user_id = $2
         AND ($3::boolean OR status IN ('scheduled', 'running'))
       ORDER BY CASE WHEN status IN ('scheduled', 'running') THEN 0 ELSE 1 END,
                CASE WHEN status IN ('scheduled', 'running') THEN run_at END ASC,
                run_at DESC
       LIMIT $4`,
      [organizationId, userId, options.includeFinished === true, limit],
    );
    return result.rows.map(mapScheduled);
  }

  async cancelScheduledAction(organizationId: string, userId: string, id: string) {
    const result = await db.query(
      `UPDATE ai.scheduled_actions
       SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
       WHERE organization_id = $1 AND user_id = $2 AND id = $3 AND status = 'scheduled'
       RETURNING *`,
      [organizationId, userId, id],
    );
    if (result.rows[0]) return mapScheduled(result.rows[0]);
    const existing = await db.query(
      `SELECT 1 FROM ai.scheduled_actions WHERE organization_id = $1 AND user_id = $2 AND id = $3`,
      [organizationId, userId, id],
    );
    return existing.rows[0] ? 'not_scheduled' : null;
  }

  async claimDueScheduledActions(now: Date, limit: number) {
    const result = await db.query(
      `UPDATE ai.scheduled_actions
       SET status = 'running', started_at = NOW(), updated_at = NOW()
       WHERE id IN (
         SELECT id FROM ai.scheduled_actions
         WHERE status = 'scheduled' AND run_at <= $1
         ORDER BY run_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       RETURNING *`,
      [now, limit],
    );
    return result.rows.map(mapScheduled);
  }

  async finishScheduledAction(id: string, status: 'done' | 'failed', outcome: { result?: Record<string, unknown> | null; error?: string | null }) {
    await db.query(
      `UPDATE ai.scheduled_actions
       SET status = $2, result = $3::jsonb, error = $4, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, status, outcome.result ? JSON.stringify(outcome.result) : null, outcome.error ?? null],
    );
  }
}

export class MemoryAgentStore implements AgentStore {
  plans: AgentPlanRecord[] = [];
  scheduled: ScheduledActionRecord[] = [];

  async createPlan(input: Parameters<AgentStore['createPlan']>[0]) {
    const plan: AgentPlanRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      userId: input.userId,
      threadId: input.threadId,
      messageId: null,
      status: 'pending',
      steps: input.steps,
      results: [],
      expiresAt: input.expiresAt,
      decidedAt: null,
      createdAt: new Date(),
    };
    this.plans.push(plan);
    return { ...plan };
  }

  async attachPlanMessage(planId: string, messageId: string) {
    const plan = this.plans.find((item) => item.id === planId);
    if (plan) plan.messageId = messageId;
  }

  async getPlan(organizationId: string, userId: string, planId: string) {
    const plan = this.plans.find((item) => item.id === planId && item.organizationId === organizationId && item.userId === userId);
    return plan ? { ...plan } : null;
  }

  async claimPlan(organizationId: string, userId: string, planId: string, status: 'running' | 'cancelled') {
    const plan = this.plans.find((item) => item.id === planId && item.organizationId === organizationId && item.userId === userId);
    if (!plan || plan.status !== 'pending' || plan.expiresAt.getTime() <= Date.now()) return null;
    plan.status = status;
    plan.decidedAt = new Date();
    return { ...plan };
  }

  async finishPlan(planId: string, status: 'completed' | 'failed', results: PlanStepResult[]) {
    const plan = this.plans.find((item) => item.id === planId);
    if (plan) {
      plan.status = status;
      plan.results = results;
    }
  }

  async createScheduledAction(input: CreateScheduledActionInput) {
    const row: ScheduledActionRecord = {
      ...input,
      id: randomUUID(),
      status: 'scheduled',
      result: null,
      error: null,
      finishedAt: null,
      createdAt: new Date(),
    };
    this.scheduled.push(row);
    return { ...row };
  }

  async listScheduledActions(organizationId: string, userId: string, options: { includeFinished?: boolean; limit?: number } = {}) {
    return this.scheduled
      .filter((row) => row.organizationId === organizationId && row.userId === userId)
      .filter((row) => options.includeFinished || row.status === 'scheduled' || row.status === 'running')
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, options.limit ?? 50)
      .map((row) => ({ ...row }));
  }

  async cancelScheduledAction(organizationId: string, userId: string, id: string) {
    const row = this.scheduled.find((item) => item.id === id && item.organizationId === organizationId && item.userId === userId);
    if (!row) return null;
    if (row.status !== 'scheduled') return 'not_scheduled' as const;
    row.status = 'cancelled';
    row.finishedAt = new Date();
    return { ...row };
  }

  async claimDueScheduledActions(now: Date, limit: number) {
    const due = this.scheduled
      .filter((row) => row.status === 'scheduled' && row.runAt.getTime() <= now.getTime())
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, limit);
    due.forEach((row) => {
      row.status = 'running';
    });
    return due.map((row) => ({ ...row }));
  }

  async finishScheduledAction(id: string, status: 'done' | 'failed', outcome: { result?: Record<string, unknown> | null; error?: string | null }) {
    const row = this.scheduled.find((item) => item.id === id);
    if (!row) return;
    row.status = status;
    row.result = outcome.result ?? null;
    row.error = outcome.error ?? null;
    row.finishedAt = new Date();
  }
}
