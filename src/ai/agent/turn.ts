import { parseTimeRequest } from '../time-actions.js';
import type { AgentContext } from './actions.js';
import { extractActionBlock, preparePlan, runReadSteps, type RawStep } from './planner.js';
import type { PlanStepRecord, PlanStepResult } from './store.js';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type Complete = (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<string>;

const MAX_HISTORY_CHARS = 24_000;
const MAX_MEMORY = 8;
const MAX_READ_ROUNDS = 2;

/** Keeps the newest turns within budget and lists older user requests so long chats keep their thread. */
export function compactHistory(turns: ChatTurn[], maxChars = MAX_HISTORY_CHARS) {
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (kept.length > 0 && used + turn.content.length > maxChars) break;
    kept.unshift(turn);
    used += turn.content.length;
  }
  const dropped = turns.slice(0, turns.length - kept.length);
  const earlier = dropped
    .filter((turn) => turn.role === 'user')
    .slice(-12)
    .map((turn) => `- ${turn.content.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  if (kept[0]?.role === 'assistant') kept.shift();
  return { turns: kept, earlierTopics: earlier };
}

export function memoryFromMetadata(metadata: Record<string, unknown> | null | undefined) {
  const memory = metadata?.kodexMemory;
  if (!Array.isArray(memory)) return [];
  return memory.filter((item): item is string => typeof item === 'string').slice(-MAX_MEMORY);
}

export function rememberResults(previous: string[], steps: PlanStepRecord[], results: PlanStepResult[], now: Date) {
  const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Harare', hour: '2-digit', minute: '2-digit' }).format(now);
  const lines = results
    .filter((result) => result.status === 'done' || result.status === 'scheduled')
    .map((result) => {
      const step = steps.find((item) => item.id === result.id);
      const ref = result.ref ? ` (id ${result.ref})` : result.scheduledActionId ? ` (scheduled task id ${result.scheduledActionId})` : '';
      return `${stamp} ${step?.summary ?? result.summary}${ref}`;
    });
  return [...previous, ...lines].slice(-MAX_MEMORY);
}

const CONFIRM = /^(yes|yep|yeah|ya|y|ok|okay|sure|confirm(ed)?|go ahead|do it|please do|proceed|correct|that'?s right)\b[\s!.,]*(please|thanks|thank you|kodex)?[\s!.]*$/i;
const CANCEL = /^(no|nope|nah|cancel|stop|don'?t|do not|never ?mind|abort)\b[\s!.,]*(please|thanks|kodex)?[\s!.]*$/i;

export function planReplyIntent(message: string): 'confirm' | 'cancel' | null {
  const text = message.trim();
  if (text.length > 40) return null;
  if (CONFIRM.test(text)) return 'confirm';
  if (CANCEL.test(text)) return 'cancel';
  return null;
}

const SCHEDULE_HINT = /\b(at\s+\d|\d\s*(am|pm)\b|\d{1,2}:\d{2}|tomorrow|tonight|later|in\s+\d+\s*(min|minute|hour)|then|after|before|every|remind|create|card named|called|move|assign)\b/i;

/** Plain "start my timer on X" / "log 2 hours on X" requests skip the model. */
export function quickTimeSteps(message: string): RawStep[] | null {
  if (SCHEDULE_HINT.test(message)) return null;
  const intent = parseTimeRequest(message);
  if (!intent || intent.kind === 'status' || !intent.task) return null;
  if (intent.kind === 'start') return [{ id: 's1', action: 'start_timer', args: { card: intent.task }, at: null }];
  if (intent.kind === 'log') {
    return [{ id: 's1', action: 'log_time', args: { card: intent.task, minutes: Math.round(intent.seconds / 60) }, at: null }];
  }
  return null;
}

export type AgentTurnResult = {
  reply: string;
  steps: PlanStepRecord[];
  errors: string[];
  lookups: string[];
};

export async function runAgentTurn(input: {
  ctx: AgentContext;
  complete: Complete;
  system: string;
  turns: ChatTurn[];
}): Promise<AgentTurnResult> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: input.system },
    ...input.turns,
  ];
  const lookups: string[] = [];
  for (let round = 0; ; round += 1) {
    const content = await input.complete(messages);
    const { reply, steps } = extractActionBlock(content);
    if (!steps || steps.length === 0) return { reply, steps: [], errors: [], lookups };
    const prepared = await preparePlan(input.ctx, steps);
    if (prepared.reads.length > 0 && round < MAX_READ_ROUNDS) {
      const results = await runReadSteps(input.ctx, prepared.reads);
      lookups.push(...prepared.reads.map((step) => step.action));
      messages.push(
        { role: 'assistant', content: reply || 'Let me check that.' },
        {
          role: 'user',
          content: `[KODEX lookup results. These come from the workspace, not from me.]\n${results}\n\nUse these results to answer my previous message. If a change is still needed, include a kodex-actions block.`,
        },
      );
      continue;
    }
    return { reply, steps: prepared.steps, errors: prepared.errors, lookups };
  }
}
