import { hasPermission } from '../authorization/permissions.js';
import type { AuthContext } from '../authorization/types.js';
import { resolveManualEntryAccess, type ManualEntryAccess } from '../work/manual-entry-policy.js';

const MAX_MANUAL_SECONDS = 24 * 60 * 60;
const HOUR_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  an: 1,
  a: 1,
};

const PLACEHOLDER_TASKS = new Set([
  'certain',
  'a certain',
  'certain task',
  'a certain task',
  'some task',
  'a task',
  'the task',
  'that task',
  'this task',
  'my task',
  'some card',
  'a card',
  'the card',
  'that card',
  'this card',
  'it',
  'one',
  'something',
  'somewhere',
]);

export type TimeCardMatch = {
  id: string;
  title: string;
  boardName: string | null;
};

export type TimeRunningRow = {
  id: string;
  cardId: string;
  cardTitle?: string | null;
  boardName?: string | null;
  userId: string;
  userName?: string | null;
  startedAt: Date | null;
  endedAt?: Date | null;
};

export type TimeActionSource = {
  listRunning(organizationId: string, userId: string | null): Promise<TimeRunningRow[]>;
  findCards(organizationId: string, query: string): Promise<TimeCardMatch[]>;
  createEntry(input: {
    organizationId: string;
    cardId: string;
    userId: string;
    seconds: number;
    note: string;
    startedAt: Date | null;
    endedAt: Date | null;
  }): Promise<{ id: string; endedAt?: Date | null } | null>;
  manualEntryAccess?(auth: AuthContext, at: Date): Promise<Pick<ManualEntryAccess, 'mode'>>;
};

async function defaultManualEntryAccess(auth: AuthContext, at: Date) {
  const { postgresManualEntryPolicySource } = await import('../work/manual-entries-postgres.js');
  return resolveManualEntryAccess(postgresManualEntryPolicySource, auth, auth.actor.userId, at);
}

type TimeIntent =
  | { kind: 'status'; scope: 'own' | 'team' }
  | { kind: 'start'; task: string | null }
  | { kind: 'log'; task: string | null; seconds: number }
  | { kind: 'choose'; task: string | null; seconds: number };

function canReadTime(auth: AuthContext) {
  return auth.membership.isAdminRole || hasPermission(auth.membership.permissions, 'work.time_entries.read');
}

function canCreateTime(auth: AuthContext) {
  return auth.membership.isAdminRole || hasPermission(auth.membership.permissions, 'work.time_entries.create');
}

function isTimeStaff(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it'
  );
}

function mentionsTime(text: string) {
  return (
    /\b(timers?|time entries|time entry|manual time|logged time|log time|track time|tracking time)\b/i.test(text) ||
    /\btime running\b/i.test(text) ||
    (/\bhours?\b/i.test(text) && /\b(add|log|manual|time)\b/i.test(text))
  );
}

function parseSeconds(text: string) {
  const half = text.match(/\bhalf an hour\b|\bhalf hour\b/i);
  if (half) return 30 * 60;
  const numericHours = text.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i);
  if (numericHours) return Math.round(Number(numericHours[1]) * 3600);
  const shortHours = text.match(/\b(\d+(?:\.\d+)?)h\b/i);
  if (shortHours) return Math.round(Number(shortHours[1]) * 3600);
  const wordHours = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|an|a)\s+hours?\b/i);
  if (wordHours) return HOUR_WORDS[wordHours[1].toLowerCase()] * 3600;
  const minutes = text.match(/\b(\d+)\s*(?:minutes?|mins?)\b/i);
  if (minutes) return Number(minutes[1]) * 60;
  return null;
}

function cleanTask(raw: string) {
  let value = raw.replace(/\s+/g, ' ').trim();
  value = value.replace(/[?.!,"“”]+$/g, '').trim();
  value = value.replace(/\s+(?:and|or)\s+(?:start|begin|resume|add|log|please|if|then)\b[\s\S]*$/i, '').trim();
  value = value.replace(/\s+if\s+not\b[\s\S]*$/i, '').trim();
  value = value.replace(/^(?:the|a|an)\s+/i, '').trim();
  value = value.replace(/\s+(?:task|card)$/i, '').trim();
  if (/^(?:start|begin|resume|add|log|please|my timer|a timer|the timer|timer)\b/i.test(value)) {
    return null;
  }
  if (value.length < 2 || value.length > 80) return null;
  if (PLACEHOLDER_TASKS.has(value.toLowerCase())) return null;
  return value;
}

function firstTask(text: string, pattern: RegExp) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    const cleaned = cleanTask(match[1] ?? '');
    if (cleaned) return cleaned;
  }
  return null;
}

function extractTask(text: string) {
  const quoted = text.match(/["“]([^"”]{2,80})["”]/) ?? text.match(/'([^']{2,80})'/);
  if (quoted) {
    const cleaned = cleanTask(quoted[1]);
    if (cleaned) return cleaned;
  }
  return (
    firstTask(text, /\bgo to\s+(?:the\s+)?(?:task\s+|card\s+)?(.{2,80})/i) ??
    firstTask(text, /\b(?:on|for|to|onto)\s+(?:the\s+)?(?:task|card)\s+(?:called|named|titled)?\s*[:\-]?\s*(.{2,80})/i) ??
    firstTask(text, /\b(?:called|named|titled)\s+(.{2,80})/i) ??
    firstTask(text, /\b(?:on|for|to|onto)\s+(.{2,80})/i)
  );
}

export function parseTimeRequest(message: string): TimeIntent | null {
  const text = message.trim();
  if (!mentionsTime(text)) return null;
  const seconds = parseSeconds(text);
  const task = extractTask(text);
  const wantsLog = seconds !== null && /\b(add|log|manual|put)\b/i.test(text);
  const wantsStart = /\b(start|begin|resume)\b/i.test(text) && /\btimers?\b/i.test(text);
  const team = /\b(everyone|everybody|anyone|who|the team|staff|organization|org wide|org-wide)\b/i.test(text);
  if (wantsLog && wantsStart) return { kind: 'choose', task, seconds };
  if (wantsLog) return { kind: 'log', task, seconds };
  if (wantsStart) return { kind: 'start', task };
  if (/\b(running|timers?)\b/i.test(text) || /\btime running\b/i.test(text)) {
    return { kind: 'status', scope: team ? 'team' : 'own' };
  }
  return null;
}

function stamp(date: Date | null) {
  if (!date) return 'an unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Harare',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  }).format(date);
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  const parts: string[] = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(' ') || '0 minutes';
}

function cardLabel(title: string | null | undefined, board?: string | null) {
  const name = title?.trim() || 'a task';
  return board?.trim() ? `${name} (${board.trim()})` : name;
}

function describeOwn(rows: TimeRunningRow[]) {
  if (rows.length === 0) return 'You do not have a timer running.';
  const lines = rows.slice(0, 8).map(
    (row) => `${cardLabel(row.cardTitle, row.boardName)} since ${stamp(row.startedAt)}`,
  );
  return `You have a timer running on ${lines.join('; ')}.`;
}

async function ownRunning(auth: AuthContext, source: TimeActionSource) {
  const rows = await source.listRunning(auth.membership.organizationId, auth.actor.userId);
  return rows.filter((row) => row.userId === auth.actor.userId && row.endedAt == null);
}

function pickCard(cards: TimeCardMatch[], query: string): TimeCardMatch | 'many' | 'none' {
  if (cards.length === 0) return 'none';
  const expected = query.trim().toLowerCase();
  const exact = cards.filter((card) => card.title.trim().toLowerCase() === expected);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return 'many';
  if (cards.length === 1) return cards[0];
  return 'many';
}

function matchList(cards: TimeCardMatch[]) {
  return cards
    .slice(0, 8)
    .map((card) => cardLabel(card.title, card.boardName))
    .join(', ');
}

async function requireTaskCard(auth: AuthContext, source: TimeActionSource, task: string | null) {
  if (!task) {
    return { error: 'Tell me the task name. For example: start my timer on Homepage. Nothing was changed.' };
  }
  const cards = await source.findCards(auth.membership.organizationId, task);
  const picked = pickCard(cards, task);
  if (picked === 'none') {
    return { error: `I could not find an open task named ${task}. Nothing was changed.` };
  }
  if (picked === 'many') {
    return {
      error: `More than one task matches ${task}: ${matchList(cards)}. Name the exact task. Nothing was changed.`,
    };
  }
  return { card: picked };
}

export async function timerFacts(auth: AuthContext, source: TimeActionSource) {
  if (!canReadTime(auth)) return 'Task timers: hidden for this role.';
  const own = await ownRunning(auth, source);
  const lines = [
    'Your running task timers:',
    own.length
      ? own.slice(0, 8).map((row) => `- You: ${cardLabel(row.cardTitle, row.boardName)} since ${stamp(row.startedAt)}`).join('\n')
      : '- None.',
  ];
  if (isTimeStaff(auth)) {
    const all = await source.listRunning(auth.membership.organizationId, null);
    const others = all.filter((row) => row.userId !== auth.actor.userId).slice(0, 15);
    lines.push('Other running task timers:');
    lines.push(
      others.length
        ? others.map((row) => `- ${row.userName?.trim() || 'A teammate'}: ${cardLabel(row.cardTitle, row.boardName)}`).join('\n')
        : '- None.',
    );
  }
  lines.push('Do not claim a timer was started or hours were logged unless this turn already recorded it.');
  return lines.join('\n');
}

export async function resolveTimeChat(auth: AuthContext, message: string, source: TimeActionSource) {
  const intent = parseTimeRequest(message);
  if (!intent) return null;
  try {
    return await runTimeIntent(auth, source, intent);
  } catch {
    return 'I could not check or change task timers just now. Nothing was changed.';
  }
}

async function runTimeIntent(auth: AuthContext, source: TimeActionSource, intent: TimeIntent) {
  if (!canReadTime(auth)) {
    return 'This role cannot see task timers. Nothing was changed.';
  }
  const running = await ownRunning(auth, source);

  if (intent.kind === 'status') {
    if (intent.scope === 'team') {
      if (!isTimeStaff(auth)) {
        return `${describeOwn(running)} You can only see your own task timer.`;
      }
      const all = await source.listRunning(auth.membership.organizationId, null);
      if (all.length === 0) return 'Nobody has a task timer running.';
      const lines = all.slice(0, 25).map((row) => {
        const who = row.userId === auth.actor.userId ? 'You' : row.userName?.trim() || 'A teammate';
        return `${who} on ${cardLabel(row.cardTitle, row.boardName)}`;
      });
      return `Running task timers: ${lines.join('; ')}.`;
    }
    return describeOwn(running);
  }

  if (!canCreateTime(auth)) {
    return `${describeOwn(running)} This role cannot start a timer or add manual time. Nothing was changed.`;
  }

  if (intent.kind === 'choose') {
    const amount = formatDuration(intent.seconds);
    const where = intent.task ? ` on ${intent.task}` : '';
    return `${describeOwn(running)} Say which one you want${where}: start a timer, or add ${amount} of manual time. Nothing was changed.`;
  }

  if (intent.kind === 'start') {
    if (running.length > 0) {
      return `${describeOwn(running)} I did not start another timer.`;
    }
    const picked = await requireTaskCard(auth, source, intent.task);
    if ('error' in picked) return picked.error;
    const startedAt = new Date();
    const created = await source.createEntry({
      organizationId: auth.membership.organizationId,
      cardId: picked.card.id,
      userId: auth.actor.userId,
      seconds: 0,
      note: 'Started from KODEX',
      startedAt,
      endedAt: null,
    });
    if (!created) return 'That task is not open. Nothing was changed.';
    const label = cardLabel(picked.card.title, picked.card.boardName);
    if (created.endedAt) {
      return `I tried to start your timer on ${label}, but it was closed at the 18:00 Africa/Harare cutoff. Add manual time if you still need those hours.`;
    }
    return `No timer was running. I started your timer on ${label}.`;
  }

  if (intent.seconds > MAX_MANUAL_SECONDS || intent.seconds < 60) {
    return 'I can add between 1 minute and 24 hours of manual time. Nothing was changed.';
  }
  const access = await (source.manualEntryAccess ?? defaultManualEntryAccess)(auth, new Date());
  if (access.mode === 'approval') {
    return 'Manual time entries are switched off, so I cannot add that time directly. Open My Time, choose Add manual entry, and give a reason. It only counts once an approver accepts it. Nothing was changed.';
  }
  const picked = await requireTaskCard(auth, source, intent.task);
  if ('error' in picked) return picked.error;
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - intent.seconds * 1000);
  const created = await source.createEntry({
    organizationId: auth.membership.organizationId,
    cardId: picked.card.id,
    userId: auth.actor.userId,
    seconds: intent.seconds,
    note: 'Manual time from KODEX',
    startedAt,
    endedAt,
  });
  if (!created) return 'That task is not open. Nothing was changed.';
  const already = running.length ? ` ${describeOwn(running)}` : '';
  return `I added ${formatDuration(intent.seconds)} of manual time on ${cardLabel(picked.card.title, picked.card.boardName)}. That entry is closed, so it is not a running timer.${already}`;
}
