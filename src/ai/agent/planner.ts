import {
  actionAllowed,
  availableActions,
  findAction,
  formatWhen,
  isStepRef,
  type AgentContext,
} from './actions.js';
import type { AgentStore, PlanStepRecord, PlanStepResult } from './store.js';

export const MAX_PLAN_STEPS = 8;
export const MAX_SCHEDULE_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;
const PAST_TOLERANCE_MS = 2 * 60 * 1000;
const IMMEDIATE_WINDOW_MS = 60 * 1000;

export type RawStep = { id: string; action: string; args: Record<string, unknown>; at: string | null };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stripThinking(content: string) {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

function parseSteps(json: string): RawStep[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const rawSteps = Array.isArray(parsed) ? parsed : record(parsed).steps;
  if (!Array.isArray(rawSteps)) return null;
  return rawSteps.slice(0, MAX_PLAN_STEPS).map((item, index) => {
    const row = record(item);
    const id = typeof row.id === 'string' && /^s\d{1,2}$/.test(row.id.trim()) ? row.id.trim() : `s${index + 1}`;
    const at = typeof row.at === 'string' && row.at.trim() ? row.at.trim() : null;
    return { id, action: String(row.action ?? row.name ?? '').trim(), args: record(row.args ?? row.arguments), at };
  });
}

/** Splits a model reply into the user-facing text and an optional kodex-actions block. */
export function extractActionBlock(content: string): { reply: string; steps: RawStep[] | null } {
  const cleaned = stripThinking(content);
  const fence = /```(?:kodex-actions|kodex|json)?\s*\n?([\s\S]*?)```/gi;
  let steps: RawStep[] | null = null;
  let reply = cleaned;
  for (const match of cleaned.matchAll(fence)) {
    const candidate = parseSteps(match[1].trim());
    if (candidate) {
      steps = candidate;
      reply = cleaned.replace(match[0], '').trim();
      break;
    }
  }
  if (!steps) {
    const inline = cleaned.match(/\{\s*"steps"\s*:\s*\[[\s\S]*\]\s*\}\s*$/);
    const candidate = inline ? parseSteps(inline[0]) : null;
    if (candidate) {
      steps = candidate;
      reply = cleaned.slice(0, inline!.index).trim();
    }
  }
  return { reply, steps };
}

function harareNow(now: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Harare',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
}

function harareIso(now: Date) {
  const shifted = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 16)}:00+02:00`;
}

export function buildAgentInstructions(ctx: AgentContext, memory: string[] = []) {
  const actions = availableActions(ctx);
  const lines = actions.map((action) => {
    const tags = [
      action.kind === 'read' ? 'read, runs immediately' : 'change, needs confirmation',
      action.scheduledOnly ? 'needs "at"' : action.schedulable && action.kind === 'write' ? 'can be scheduled' : action.kind === 'write' ? 'cannot be scheduled' : '',
    ].filter(Boolean);
    return `- ${action.signature}: ${action.description} [${tags.join('; ')}]`;
  });
  const names = new Set(actions.map((action) => action.name));
  const example = names.has('create_card') && names.has('start_timer')
    ? '{"steps":[{"id":"s1","action":"create_card","args":{"title":"Website audit","board":"Marketing","column":"Backlog"}},{"id":"s2","action":"start_timer","args":{"card":"$s1"},"at":"2026-01-31T15:00:00+02:00"}]}'
    : '{"steps":[{"id":"s1","action":"<action name>","args":{"<arg>":"<value>"}}]}';
  const webNote = actions.some((action) => action.name === 'web_search')
    ? ''
    : 'Web search is not connected yet. You can still read a specific page with read_webpage when the user gives an address.';
  return [
    'KODEX ACTIONS',
    `You can act in this workspace for the user. Current time: ${harareNow(ctx.now)} (Africa/Harare, ${harareIso(ctx.now)}).`,
    'When the user asks you to do, change, schedule or look up something these actions cover, write one or two short sentences and then exactly one block:',
    '```kodex-actions',
    example,
    '```',
    'Rules:',
    '- Use only the actions listed below with their listed args. Pass the names the user used for boards, cards, columns and people; the platform resolves them.',
    '- A later step can use the card created by an earlier step that runs now: "card":"$s1".',
    '- "at" schedules a step for later. It must be a full ISO 8601 time with the +02:00 offset. "at 3pm" means today 15:00 if that is still ahead; otherwise ask. Leave "at" out to act now.',
    '- Changes are shown to the user with Confirm and Cancel buttons and only run after they confirm. Never claim a change is done; say what will happen once they confirm.',
    '- Read actions run straight away and their results come back to you in the next message. Then answer from those results.',
    '- If something essential is missing (which board, which card, what time), ask a short question instead of guessing. Ordinary questions get a normal answer with no block.',
    webNote,
    'Available actions:',
    ...lines,
    memory.length ? `Recent KODEX actions in this chat (newest last):\n${memory.map((item) => `- ${item}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export type PreparedPlan = { steps: PlanStepRecord[]; errors: string[]; reads: RawStep[] };

/** Validates and resolves the model's steps. Reads come back separately; they run before any plan is shown. */
export async function preparePlan(ctx: AgentContext, rawSteps: RawStep[]): Promise<PreparedPlan> {
  const steps: PlanStepRecord[] = [];
  const errors: string[] = [];
  const reads: RawStep[] = [];
  const immediate = new Set<string>();
  for (const raw of rawSteps) {
    const action = findAction(raw.action);
    if (!action) {
      errors.push(`I do not have an action called "${raw.action || 'unknown'}".`);
      continue;
    }
    if (!actionAllowed(ctx, action)) {
      errors.push(`Your role cannot use ${action.name.replace(/_/g, ' ')}.`);
      continue;
    }
    let runAt: Date | null = null;
    if (raw.at) {
      const parsed = new Date(raw.at);
      if (Number.isNaN(parsed.getTime())) {
        errors.push(`I could not read the time "${raw.at}".`);
        continue;
      }
      if (parsed.getTime() < ctx.now.getTime() - PAST_TOLERANCE_MS) {
        errors.push(`${formatWhen(parsed)} has already passed.`);
        continue;
      }
      if (parsed.getTime() - ctx.now.getTime() > MAX_SCHEDULE_AHEAD_MS) {
        errors.push('I can schedule up to 31 days ahead.');
        continue;
      }
      runAt = parsed.getTime() - ctx.now.getTime() <= IMMEDIATE_WINDOW_MS ? null : parsed;
    }
    if (action.kind === 'read') {
      if (runAt) errors.push(`Lookups like ${action.name.replace(/_/g, ' ')} run straight away and cannot be scheduled.`);
      else reads.push(raw);
      continue;
    }
    if (runAt && !action.schedulable) {
      errors.push(`${action.name.replace(/_/g, ' ')} cannot be scheduled for later; it has to happen when you ask.`);
      continue;
    }
    if (!runAt && action.scheduledOnly) {
      errors.push('Tell me when the reminder should go off.');
      continue;
    }
    const badRef = Object.values(raw.args).find(
      (value) => isStepRef(value) && !immediate.has(String(value).trim().slice(1)),
    );
    if (badRef) {
      errors.push('A step can only use a card from an earlier step that runs straight away.');
      continue;
    }
    const prepared = action.prepare ? await action.prepare(ctx, raw.args) : { ok: true as const, args: raw.args, summary: action.name };
    if (!prepared.ok) {
      errors.push(prepared.error);
      continue;
    }
    if (!runAt) immediate.add(raw.id);
    steps.push({ id: raw.id, action: action.name, args: prepared.args, summary: prepared.summary, runAt: runAt?.toISOString() ?? null });
  }
  return { steps, errors, reads };
}

export async function runReadSteps(ctx: AgentContext, reads: RawStep[]) {
  const lines: string[] = [];
  for (const step of reads.slice(0, 4)) {
    const action = findAction(step.action);
    if (!action) continue;
    try {
      const outcome = await action.run(ctx, step.args);
      lines.push(`${step.action}: ${outcome.ok ? outcome.summary : `failed: ${outcome.error}`}`);
    } catch (error) {
      lines.push(`${step.action}: failed: ${error instanceof Error ? error.message : 'unexpected error'}`);
    }
  }
  return lines.join('\n\n').slice(0, 9_000);
}

export function describePlan(steps: PlanStepRecord[]) {
  return steps
    .map((step, index) => `${index + 1}. ${step.runAt ? `At ${formatWhen(step.runAt)}: ` : ''}${step.summary}`)
    .join('\n');
}

function substitute(args: Record<string, unknown>, refs: Map<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isStepRef(value)) {
      const ref = refs.get(String(value).trim().slice(1));
      if (!ref) return null;
      out[key] = ref;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export type PlanRunContext = {
  store: AgentStore;
  threadId: string | null;
  planId: string | null;
};

export async function executePlanSteps(ctx: AgentContext, steps: PlanStepRecord[], run: PlanRunContext) {
  const results: PlanStepResult[] = [];
  const refs = new Map<string, string>();
  let failed = false;
  for (const step of steps) {
    if (failed) {
      results.push({ id: step.id, status: 'skipped', summary: `Skipped: ${step.summary}` });
      continue;
    }
    const action = findAction(step.action);
    const args = substitute(step.args, refs);
    if (!action || !args) {
      failed = true;
      results.push({ id: step.id, status: 'failed', summary: `${step.summary}: an earlier step did not finish.` });
      continue;
    }
    if (step.runAt) {
      const scheduled = await run.store.createScheduledAction({
        organizationId: ctx.auth.membership.organizationId,
        userId: ctx.auth.actor.userId,
        threadId: run.threadId,
        planId: run.planId,
        action: step.action,
        args,
        summary: step.summary,
        runAt: new Date(step.runAt),
      });
      results.push({
        id: step.id,
        status: 'scheduled',
        summary: `Scheduled for ${formatWhen(step.runAt)}: ${step.summary}`,
        scheduledActionId: scheduled.id,
      });
      continue;
    }
    try {
      const outcome = await action.run(ctx, args);
      if (outcome.ok) {
        if (outcome.ref) refs.set(step.id, outcome.ref);
        results.push({ id: step.id, status: 'done', summary: outcome.summary, ref: outcome.ref ?? null });
      } else {
        failed = true;
        results.push({ id: step.id, status: 'failed', summary: `${step.summary}: ${outcome.error}` });
      }
    } catch (error) {
      failed = true;
      results.push({
        id: step.id,
        status: 'failed',
        summary: `${step.summary}: ${error instanceof Error ? error.message : 'unexpected error'}`,
      });
    }
  }
  return { results, failed };
}

export function describeResults(results: PlanStepResult[]) {
  return results
    .map((result) => {
      if (result.status === 'done') return `- Done: ${result.summary}`;
      if (result.status === 'failed') return `- Failed: ${result.summary}`;
      return `- ${result.summary}`;
    })
    .join('\n');
}
