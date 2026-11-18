import type { AuthContext } from '../../authorization/types.js';
import { logger } from '../../config/logger.js';
import { actionAllowed, findAction, formatWhen, type AgentContext, type CardMatch, type MemberRow } from './actions.js';
import type { InternalApi } from './internal-api.js';
import { describeResults, executePlanSteps } from './planner.js';
import type { AgentPlanRecord, AgentStore, PlanStepResult } from './store.js';
import { memoryFromMetadata, rememberResults } from './turn.js';
import type { WebTools } from './web.js';

export const PLAN_TTL_MS = 30 * 60 * 1000;
const SCHEDULED_BATCH = 20;

export type AgentThreadStore = {
  addMessage(
    organizationId: string,
    userId: string,
    threadId: string,
    input: { role: 'user' | 'assistant' | 'system'; content: string; metadata?: Record<string, unknown> },
  ): Promise<{ id: string; created_at: string | null; metadata: Record<string, unknown> }>;
  getThread(organizationId: string, userId: string, threadId: string): Promise<{ metadata: Record<string, unknown> }>;
  updateThread(organizationId: string, userId: string, threadId: string, patch: { metadata?: Record<string, unknown> }): Promise<unknown>;
  updateMessageMetadata(organizationId: string, threadId: string, messageId: string, patch: Record<string, unknown>): Promise<void>;
};

export type AgentRuntime = {
  api: InternalApi;
  store: AgentStore;
  threads: AgentThreadStore;
  resolveAuth(userId: string): Promise<AuthContext>;
  findCards(organizationId: string, query: string): Promise<CardMatch[]>;
  listMembers?(organizationId: string): Promise<MemberRow[]>;
  web?: WebTools;
  notify?(input: { auth: AuthContext; title: string; message: string; entityId: string }): Promise<void>;
};

let runtime: AgentRuntime | null = null;

export function setAgentRuntime(value: AgentRuntime | null) {
  runtime = value;
}

export function getAgentRuntime() {
  return runtime;
}

export function agentContext(rt: AgentRuntime, auth: AuthContext, now = new Date()): AgentContext {
  return {
    auth,
    api: rt.api,
    now,
    findCards: rt.findCards,
    listMembers: rt.listMembers,
    store: rt.store,
    web: rt.web,
    notify: rt.notify
      ? (input) => rt.notify!({ ...input, entityId: auth.actor.userId })
      : undefined,
  };
}

export function serializePlan(plan: AgentPlanRecord) {
  return {
    id: plan.id,
    status: plan.status,
    expiresAt: plan.expiresAt.toISOString(),
    steps: plan.steps.map((step) => ({ id: step.id, action: step.action, summary: step.summary, runAt: step.runAt })),
    results: plan.results,
  };
}

async function remember(rt: AgentRuntime, auth: AuthContext, plan: AgentPlanRecord, results: PlanStepResult[]) {
  try {
    const thread = await rt.threads.getThread(auth.membership.organizationId, auth.actor.userId, plan.threadId);
    const memory = rememberResults(memoryFromMetadata(thread.metadata), plan.steps, results, new Date());
    await rt.threads.updateThread(auth.membership.organizationId, auth.actor.userId, plan.threadId, {
      metadata: { ...thread.metadata, kodexMemory: memory },
    });
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : String(error), planId: plan.id }, 'KODEX memory update failed');
  }
}

export type PlanDecision = {
  plan: ReturnType<typeof serializePlan>;
  reply: string;
  message: { id: string; created_at: string | null; metadata: Record<string, unknown> };
};

export async function confirmPlan(rt: AgentRuntime, auth: AuthContext, planId: string): Promise<PlanDecision | 'not_pending' | null> {
  const organizationId = auth.membership.organizationId;
  const existing = await rt.store.getPlan(organizationId, auth.actor.userId, planId);
  if (!existing) return null;
  const claimed = await rt.store.claimPlan(organizationId, auth.actor.userId, planId, 'running');
  if (!claimed) return 'not_pending';
  const ctx = agentContext(rt, auth);
  const { results, failed } = await executePlanSteps(ctx, claimed.steps, {
    store: rt.store,
    threadId: claimed.threadId,
    planId: claimed.id,
  });
  const status = failed ? 'failed' : 'completed';
  await rt.store.finishPlan(claimed.id, status, results);
  const finished: AgentPlanRecord = { ...claimed, status, results };
  await remember(rt, auth, finished, results);
  const reply = `${failed ? 'I could not finish everything:' : 'All set:'}\n${describeResults(results)}`;
  if (claimed.messageId) {
    await rt.threads.updateMessageMetadata(organizationId, claimed.threadId, claimed.messageId, {
      kodexPlan: serializePlan(finished),
    });
  }
  const message = await rt.threads.addMessage(organizationId, auth.actor.userId, claimed.threadId, {
    role: 'assistant',
    content: reply,
    metadata: { source: 'kodex', kodexPlanResult: { planId: claimed.id, status, results } },
  });
  return { plan: serializePlan(finished), reply, message };
}

export async function cancelPlan(rt: AgentRuntime, auth: AuthContext, planId: string): Promise<PlanDecision | 'not_pending' | null> {
  const organizationId = auth.membership.organizationId;
  const existing = await rt.store.getPlan(organizationId, auth.actor.userId, planId);
  if (!existing) return null;
  const claimed = await rt.store.claimPlan(organizationId, auth.actor.userId, planId, 'cancelled');
  if (!claimed) return 'not_pending';
  if (claimed.messageId) {
    await rt.threads.updateMessageMetadata(organizationId, claimed.threadId, claimed.messageId, {
      kodexPlan: serializePlan(claimed),
    });
  }
  const reply = 'Okay, I cancelled that. Nothing was changed.';
  const message = await rt.threads.addMessage(organizationId, auth.actor.userId, claimed.threadId, {
    role: 'assistant',
    content: reply,
    metadata: { source: 'kodex', kodexPlanResult: { planId: claimed.id, status: 'cancelled', results: [] } },
  });
  return { plan: serializePlan(claimed), reply, message };
}

export function serializeScheduledAction(row: Awaited<ReturnType<AgentStore['listScheduledActions']>>[number]) {
  return {
    id: row.id,
    action: row.action,
    summary: row.summary,
    runAt: row.runAt.toISOString(),
    status: row.status,
    error: row.error,
    result: row.result,
    threadId: row.threadId,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Runs due scheduled actions as their owners, re-checking each owner's current access. */
export async function runDueScheduledActions(now = new Date(), rt: AgentRuntime | null = runtime) {
  if (!rt) return { ran: 0 };
  const due = await rt.store.claimDueScheduledActions(now, SCHEDULED_BATCH);
  for (const row of due) {
    let status: 'done' | 'failed' = 'failed';
    let summary = '';
    let auth: AuthContext | null = null;
    try {
      auth = await rt.resolveAuth(row.userId);
      if (auth.membership.organizationId !== row.organizationId) throw new Error('You are no longer in this organization.');
      const action = findAction(row.action);
      const ctx = agentContext(rt, auth, now);
      if (!action) throw new Error('That action no longer exists.');
      if (!actionAllowed(ctx, action)) throw new Error('Your role can no longer do this.');
      const outcome = await action.run(ctx, row.args);
      status = outcome.ok ? 'done' : 'failed';
      summary = outcome.ok ? outcome.summary : outcome.error;
      await rt.store.finishScheduledAction(row.id, status, outcome.ok
        ? { result: { summary: outcome.summary, ref: outcome.ref ?? null } }
        : { error: outcome.error });
    } catch (error) {
      summary = error instanceof Error ? error.message : 'Unexpected error.';
      await rt.store.finishScheduledAction(row.id, 'failed', { error: summary }).catch(() => undefined);
      logger.warn({ err: summary, scheduledActionId: row.id, action: row.action }, 'KODEX scheduled action failed');
    }
    if (!auth) continue;
    const content = status === 'done'
      ? `Scheduled task for ${formatWhen(row.runAt)} ran: ${summary}`
      : `Scheduled task for ${formatWhen(row.runAt)} failed (${row.summary}): ${summary}`;
    if (row.threadId) {
      await rt.threads
        .addMessage(row.organizationId, row.userId, row.threadId, {
          role: 'assistant',
          content,
          metadata: { source: 'kodex', scheduledAction: { id: row.id, action: row.action, status } },
        })
        .catch(() => undefined);
    }
    if (row.action !== 'remind_me' || status === 'failed') {
      await rt.notify?.({ auth, title: status === 'done' ? 'KODEX finished a task' : 'KODEX task failed', message: content, entityId: row.id })
        .catch(() => undefined);
    }
  }
  return { ran: due.length };
}
