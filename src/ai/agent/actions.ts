import { authorize } from '../../authorization/authorize.js';
import type { AuthContext } from '../../authorization/types.js';
import { MANUAL_ENTRY_REASON_MIN_LENGTH } from '../../work/manual-entry-policy.js';
import { apiErrorMessage, type InternalApi } from './internal-api.js';
import type { AgentStore } from './store.js';
import type { WebTools } from './web.js';

export type MemberRow = { userId: string; fullName: string | null; email: string | null; roleKey: string | null };
export type CardMatch = { id: string; title: string; boardName: string | null };

export type AgentContext = {
  auth: AuthContext;
  api: InternalApi;
  now: Date;
  findCards(organizationId: string, query: string): Promise<CardMatch[]>;
  listMembers?(organizationId: string): Promise<MemberRow[]>;
  store?: AgentStore;
  web?: WebTools;
  notify?(input: { auth: AuthContext; title: string; message: string }): Promise<void>;
};

export type StepOutcome =
  | { ok: true; summary: string; ref?: string | null; data?: unknown }
  | { ok: false; error: string };

export type Prepared = { ok: true; args: Record<string, unknown>; summary: string } | { ok: false; error: string };

export type AgentAction = {
  name: string;
  kind: 'read' | 'write';
  /** Shown to the model. Keep short: the whole catalog travels with every planning request. */
  signature: string;
  description: string;
  schedulable: boolean;
  /** Must run at a scheduled time (reminders). */
  scheduledOnly?: boolean;
  permission?: { action: string; resourceType: string };
  available?(ctx: AgentContext): boolean;
  prepare?(ctx: AgentContext, args: Record<string, unknown>): Promise<Prepared>;
  run(ctx: AgentContext, args: Record<string, unknown>): Promise<StepOutcome>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STEP_REF = /^\$(s\d{1,2})$/;

export function isStepRef(value: unknown): value is string {
  return typeof value === 'string' && STEP_REF.test(value.trim());
}

function text(value: unknown, max = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function longText(value: unknown, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function formatWhen(value: Date | string | null | undefined) {
  if (!value) return 'an unknown time';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Harare',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function parseInstant(value: unknown) {
  const raw = text(value, 64);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateOnly(value: unknown) {
  const raw = text(value, 32);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime()) ? raw : null;
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function pickByName<T>(items: T[], name: string, label: (item: T) => string[]): T | 'many' | 'none' {
  const wanted = normalize(name);
  if (!wanted) return 'none';
  const exact = items.filter((item) => label(item).some((value) => normalize(value) === wanted));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return 'many';
  const partial = items.filter((item) => label(item).some((value) => normalize(value).includes(wanted)));
  if (partial.length === 1) return partial[0];
  return partial.length > 1 ? 'many' : 'none';
}

function cardLabel(card: { title: string; boardName?: string | null }) {
  return card.boardName ? `"${card.title}" (${card.boardName})` : `"${card.title}"`;
}

// --- Lookups -----------------------------------------------------------------

type ResolvedCard = { id: string; title: string; boardId: string | null; boardName: string | null };

async function resolveCard(ctx: AgentContext, value: unknown): Promise<ResolvedCard | { error: string }> {
  const raw = text(value, 200);
  if (!raw) return { error: 'Tell me which card.' };
  if (UUID.test(raw)) {
    const result = await ctx.api(ctx.auth, 'GET', `/cards/${raw}`);
    if (!result.ok) return { error: apiErrorMessage(result) };
    const card = record(result.body.card);
    return { id: raw, title: text(card.title, 300), boardId: text(card.boardId, 64) || null, boardName: null };
  }
  const cards = await ctx.findCards(ctx.auth.membership.organizationId, raw);
  const picked = pickByName(cards, raw, (card) => [card.title]);
  if (picked === 'none') return { error: `I could not find an open card named "${raw}".` };
  if (picked === 'many') {
    return {
      error: `More than one card matches "${raw}": ${cards.slice(0, 6).map(cardLabel).join(', ')}. Say the exact card name.`,
    };
  }
  return { id: picked.id, title: picked.title, boardId: null, boardName: picked.boardName };
}

type Board = { id: string; name: string };
type Column = { id: string; name: string; statusKey: string | null };

async function listBoards(ctx: AgentContext): Promise<Board[] | { error: string }> {
  const result = await ctx.api(ctx.auth, 'GET', '/boards?limit=100');
  if (!result.ok) return { error: apiErrorMessage(result) };
  return list(result.body.boards)
    .filter((board) => !board.archivedAt)
    .map((board) => ({ id: text(board.id, 64), name: text(board.name, 200) }));
}

async function resolveBoard(ctx: AgentContext, value: unknown): Promise<Board | { error: string }> {
  const raw = text(value, 200);
  if (!raw) return { error: 'Tell me which board.' };
  const boards = await listBoards(ctx);
  if ('error' in boards) return boards;
  if (UUID.test(raw)) {
    const found = boards.find((board) => board.id === raw);
    return found ?? { error: 'That board was not found.' };
  }
  const picked = pickByName(boards, raw, (board) => [board.name]);
  if (picked === 'none') {
    return { error: `I could not find a board named "${raw}". Boards: ${boards.slice(0, 12).map((b) => b.name).join(', ')}.` };
  }
  if (picked === 'many') return { error: `More than one board matches "${raw}". Say the exact board name.` };
  return picked;
}

async function listColumns(ctx: AgentContext, boardId: string): Promise<Column[] | { error: string }> {
  const result = await ctx.api(ctx.auth, 'GET', `/boards/${boardId}/columns`);
  if (!result.ok) return { error: apiErrorMessage(result) };
  return list(result.body.columns).map((column) => ({
    id: text(column.id, 64),
    name: text(column.name, 200),
    statusKey: text(column.statusKey, 80) || null,
  }));
}

async function resolveColumn(ctx: AgentContext, boardId: string, value: unknown): Promise<Column | { error: string }> {
  const columns = await listColumns(ctx, boardId);
  if ('error' in columns) return columns;
  if (columns.length === 0) return { error: 'That board has no columns yet.' };
  const raw = text(value, 200);
  if (!raw) {
    return columns.find((c) => c.statusKey === 'backlog') ?? columns.find((c) => c.statusKey === 'todo') ?? columns[0];
  }
  const picked = pickByName(columns, raw, (column) => [column.name, column.statusKey ?? '', (column.statusKey ?? '').replace(/_/g, ' ')]);
  if (picked === 'none' || picked === 'many') {
    return { error: `That board has no single column called "${raw}". Columns: ${columns.map((c) => c.name).join(', ')}.` };
  }
  return picked;
}

async function resolveMember(ctx: AgentContext, value: unknown): Promise<MemberRow | { error: string }> {
  const raw = text(value, 200);
  if (!raw) return { error: 'Tell me who.' };
  if (!ctx.listMembers) return { error: 'People lookup is not available.' };
  const members = await ctx.listMembers(ctx.auth.membership.organizationId);
  if (UUID.test(raw)) return members.find((m) => m.userId === raw) ?? { error: 'That person was not found.' };
  if (/^(me|myself|i)$/i.test(raw)) {
    return members.find((m) => m.userId === ctx.auth.actor.userId) ?? { error: 'I could not find your profile.' };
  }
  const picked = pickByName(members, raw, (m) => [m.fullName ?? '', m.email ?? '', (m.email ?? '').split('@')[0]]);
  if (picked === 'none') return { error: `I could not find a teammate named "${raw}".` };
  if (picked === 'many') return { error: `More than one teammate matches "${raw}". Use their full name or email.` };
  return picked;
}

function memberName(member: MemberRow) {
  return member.fullName?.trim() || member.email?.trim() || 'that teammate';
}

async function cardRefOrResolve(ctx: AgentContext, value: unknown) {
  if (isStepRef(value)) return { ref: String(value).trim(), label: 'the card from the earlier step' };
  const card = await resolveCard(ctx, value);
  if ('error' in card) return card;
  return { ref: card.id, label: cardLabel(card) };
}

type RunningTimer = { id: string; cardId: string; startedAt: string };

async function runningTimers(ctx: AgentContext): Promise<{ rows: RunningTimer[] } | { error: string }> {
  const result = await ctx.api(ctx.auth, 'GET', '/time-entries/running');
  if (!result.ok) return { error: apiErrorMessage(result) };
  return {
    rows: list(result.body.timeEntries)
      .filter((row) => !row.endedAt && text(row.userId, 64) === ctx.auth.actor.userId)
      .map((row) => ({ id: text(row.id, 64), cardId: text(row.cardId, 64), startedAt: text(row.startedAt, 64) })),
  };
}

async function cardTitle(ctx: AgentContext, cardId: string) {
  const result = await ctx.api(ctx.auth, 'GET', `/cards/${cardId}`);
  return result.ok ? text(record(result.body.card).title, 200) || 'a card' : 'a card';
}

async function stopTimer(ctx: AgentContext, row: { id: string; startedAt: string }) {
  const endedAt = new Date();
  const started = new Date(row.startedAt);
  const seconds = Number.isNaN(started.getTime()) ? 0 : Math.max(0, Math.round((endedAt.getTime() - started.getTime()) / 1000));
  return ctx.api(ctx.auth, 'PATCH', `/time-entries/${row.id}`, { endedAt: endedAt.toISOString(), seconds });
}

// --- Catalog -----------------------------------------------------------------

const findCards: AgentAction = {
  name: 'find_cards',
  kind: 'read',
  signature: 'find_cards {query}',
  description: 'Search open cards by title.',
  schedulable: false,
  async run(ctx, args) {
    const query = text(args.query, 120);
    if (query.length < 2) return fail('Give at least two characters to search for.');
    const cards = await ctx.findCards(ctx.auth.membership.organizationId, query);
    return {
      ok: true,
      summary: cards.length ? `Cards matching "${query}": ${cards.map((c) => `${cardLabel(c)} id ${c.id}`).join('; ')}` : `No open cards match "${query}".`,
      data: cards,
    };
  },
};

const boardOverview: AgentAction = {
  name: 'board_overview',
  kind: 'read',
  signature: 'board_overview {board}',
  description: 'Columns and cards on a board.',
  schedulable: false,
  permission: { action: 'work.cards.read', resourceType: 'work.card' },
  async run(ctx, args) {
    if (!text(args.board)) {
      const boards = await listBoards(ctx);
      if ('error' in boards) return fail(boards.error);
      return { ok: true, summary: `Boards: ${boards.map((b) => b.name).join(', ') || 'none'}.` };
    }
    const board = await resolveBoard(ctx, args.board);
    if ('error' in board) return fail(board.error);
    const [columns, cardsResult] = await Promise.all([
      listColumns(ctx, board.id),
      ctx.api(ctx.auth, 'GET', `/boards/${board.id}/cards`),
    ]);
    if ('error' in columns) return fail(columns.error);
    if (!cardsResult.ok) return fail(apiErrorMessage(cardsResult));
    const cards = list(cardsResult.body.cards).filter((card) => !card.archivedAt);
    const lines = columns.map((column) => {
      const inColumn = cards.filter((card) => card.columnId === column.id).slice(0, 15);
      const names = inColumn.map((card) => `"${text(card.title, 120)}"${card.dueAt ? ` due ${formatWhen(text(card.dueAt, 64))}` : ''}`);
      return `${column.name}: ${names.join(', ') || 'empty'}`;
    });
    return { ok: true, summary: `Board ${board.name}. ${lines.join('. ')}.` };
  },
};

const myTimers: AgentAction = {
  name: 'my_timers',
  kind: 'read',
  signature: 'my_timers {}',
  description: 'Your running task timers.',
  schedulable: false,
  permission: { action: 'work.time_entries.read', resourceType: 'work.time_entry' },
  async run(ctx) {
    const running = await runningTimers(ctx);
    if ('error' in running) return fail(running.error);
    if (running.rows.length === 0) return { ok: true, summary: 'You have no timer running.' };
    const titles = await Promise.all(running.rows.map((row) => cardTitle(ctx, row.cardId)));
    return {
      ok: true,
      summary: `Running: ${running.rows.map((row, i) => `"${titles[i]}" since ${formatWhen(row.startedAt)}`).join('; ')}.`,
    };
  },
};

const findPeople: AgentAction = {
  name: 'find_people',
  kind: 'read',
  signature: 'find_people {query}',
  description: 'Look up teammates by name or email.',
  schedulable: false,
  available: (ctx) => Boolean(ctx.listMembers),
  async run(ctx, args) {
    const query = normalize(text(args.query, 120));
    if (!ctx.listMembers) return fail('People lookup is not available.');
    const members = await ctx.listMembers(ctx.auth.membership.organizationId);
    const hits = members
      .filter((m) => !query || normalize(`${m.fullName ?? ''} ${m.email ?? ''}`).includes(query))
      .slice(0, 12);
    return {
      ok: true,
      summary: hits.length ? `People: ${hits.map((m) => `${memberName(m)} (${m.roleKey ?? 'staff'})`).join('; ')}.` : 'Nobody matches that name.',
    };
  },
};

const listScheduled: AgentAction = {
  name: 'list_scheduled',
  kind: 'read',
  signature: 'list_scheduled {}',
  description: 'Your upcoming scheduled KODEX tasks.',
  schedulable: false,
  available: (ctx) => Boolean(ctx.store),
  async run(ctx) {
    if (!ctx.store) return fail('Scheduling is not available.');
    const rows = await ctx.store.listScheduledActions(ctx.auth.membership.organizationId, ctx.auth.actor.userId);
    return {
      ok: true,
      summary: rows.length
        ? `Scheduled: ${rows.map((row) => `${row.summary} at ${formatWhen(row.runAt)} (id ${row.id})`).join('; ')}.`
        : 'You have nothing scheduled.',
    };
  },
};

const webSearch: AgentAction = {
  name: 'web_search',
  kind: 'read',
  signature: 'web_search {query}',
  description: 'Search the public web.',
  schedulable: false,
  available: (ctx) => Boolean(ctx.web?.searchAvailable()),
  async run(ctx, args) {
    const query = text(args.query, 300);
    if (!query) return fail('Tell me what to search for.');
    if (!ctx.web) return fail('Web search is not connected.');
    const results = await ctx.web.search(query);
    return {
      ok: true,
      summary: results.length
        ? `Web results for "${query}":\n${results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n${r.snippet}`).join('\n')}`
        : `No web results for "${query}".`,
      data: results,
    };
  },
};

const readWebpage: AgentAction = {
  name: 'read_webpage',
  kind: 'read',
  signature: 'read_webpage {url}',
  description: 'Read the text of a public web page.',
  schedulable: false,
  available: (ctx) => Boolean(ctx.web),
  async run(ctx, args) {
    const url = text(args.url, 2000);
    if (!url) return fail('Give me the page address.');
    if (!ctx.web) return fail('Web reading is not available.');
    const page = await ctx.web.readPage(url);
    return { ok: true, summary: `Page ${page.title || page.url} (${page.url}):\n${page.text}` };
  },
};

const createCard: AgentAction = {
  name: 'create_card',
  kind: 'write',
  signature: 'create_card {title, board, column?, description?, dueAt?, priority?}',
  description: 'Create a card. column defaults to Backlog.',
  schedulable: true,
  permission: { action: 'work.cards.create', resourceType: 'work.card' },
  async prepare(ctx, args) {
    const title = text(args.title, 300);
    if (!title) return fail('The card needs a title.');
    const board = await resolveBoard(ctx, args.board);
    if ('error' in board) return fail(board.error);
    const column = await resolveColumn(ctx, board.id, args.column);
    if ('error' in column) return fail(column.error);
    const due = args.dueAt ? parseInstant(args.dueAt) : null;
    if (args.dueAt && !due) return fail('The due date is not a valid date.');
    const priority = text(args.priority, 40).toLowerCase() || null;
    return {
      ok: true,
      args: {
        boardId: board.id,
        columnId: column.id,
        title,
        description: longText(args.description) || null,
        dueAt: due?.toISOString() ?? null,
        priority,
      },
      summary: `Create card "${title}" on ${board.name} › ${column.name}${due ? `, due ${formatWhen(due)}` : ''}${priority ? `, ${priority} priority` : ''}`,
    };
  },
  async run(ctx, args) {
    const body: Record<string, unknown> = { title: args.title, columnId: args.columnId };
    if (args.description) body.description = args.description;
    if (args.dueAt) body.dueAt = args.dueAt;
    if (args.priority) body.priority = args.priority;
    const result = await ctx.api(ctx.auth, 'POST', `/boards/${String(args.boardId)}/cards`, body);
    if (!result.ok) return fail(apiErrorMessage(result));
    const card = record(result.body.card);
    return { ok: true, summary: `Created card "${text(card.title, 300)}".`, ref: text(card.id, 64) };
  },
};

const updateCard: AgentAction = {
  name: 'update_card',
  kind: 'write',
  signature: 'update_card {card, title?, description?, dueAt?, priority?}',
  description: 'Rename a card or change its description, due date or priority.',
  schedulable: true,
  permission: { action: 'work.cards.update', resourceType: 'work.card' },
  async prepare(ctx, args) {
    const card = await cardRefOrResolve(ctx, args.card);
    if ('error' in card) return fail(card.error);
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    if (text(args.title)) {
      patch.title = text(args.title, 300);
      changes.push(`title "${patch.title}"`);
    }
    if (typeof args.description === 'string') {
      patch.description = longText(args.description) || null;
      changes.push('description');
    }
    if (args.dueAt !== undefined) {
      const due = args.dueAt === null || args.dueAt === '' ? null : parseInstant(args.dueAt);
      if (args.dueAt && !due) return fail('The due date is not a valid date.');
      patch.dueAt = due?.toISOString() ?? null;
      changes.push(due ? `due ${formatWhen(due)}` : 'no due date');
    }
    if (text(args.priority)) {
      patch.priority = text(args.priority, 40).toLowerCase();
      changes.push(`${patch.priority} priority`);
    }
    if (changes.length === 0) return fail('Tell me what to change on the card.');
    return { ok: true, args: { cardId: card.ref, patch }, summary: `Update ${card.label}: ${changes.join(', ')}` };
  },
  async run(ctx, args) {
    const result = await ctx.api(ctx.auth, 'PATCH', `/cards/${String(args.cardId)}`, record(args.patch));
    if (!result.ok) return fail(apiErrorMessage(result));
    return { ok: true, summary: `Updated "${text(record(result.body.card).title, 300)}".`, ref: String(args.cardId) };
  },
};

const moveCard: AgentAction = {
  name: 'move_card',
  kind: 'write',
  signature: 'move_card {card, column, board?}',
  description: 'Move a card to another column, optionally on another board.',
  schedulable: true,
  permission: { action: 'work.cards.update', resourceType: 'work.card' },
  async prepare(ctx, args) {
    if (isStepRef(args.card) && !text(args.board)) {
      return fail('Name the board when moving a card created in the same request.');
    }
    const card = isStepRef(args.card) ? null : await resolveCard(ctx, args.card);
    if (card && 'error' in card) return fail(card.error);
    let boardId = card?.boardId ?? null;
    let boardName = card?.boardName ?? null;
    if (card && !boardId) {
      const detail = await ctx.api(ctx.auth, 'GET', `/cards/${card.id}`);
      if (!detail.ok) return fail(apiErrorMessage(detail));
      boardId = text(record(detail.body.card).boardId, 64);
    }
    let crossBoard = false;
    if (text(args.board)) {
      const board = await resolveBoard(ctx, args.board);
      if ('error' in board) return fail(board.error);
      crossBoard = board.id !== boardId;
      boardId = board.id;
      boardName = board.name;
    }
    if (!boardId) return fail('I could not tell which board the card is on.');
    const column = await resolveColumn(ctx, boardId, args.column);
    if ('error' in column) return fail(column.error);
    const label = card ? cardLabel(card) : 'the card from the earlier step';
    return {
      ok: true,
      args: { cardId: card?.id ?? String(args.card).trim(), boardId, columnId: column.id, crossBoard },
      summary: `Move ${label} to ${boardName ? `${boardName} › ` : ''}${column.name}`,
    };
  },
  async run(ctx, args) {
    const cardId = String(args.cardId);
    const result = args.crossBoard
      ? await ctx.api(ctx.auth, 'POST', `/cards/${cardId}/move`, { targetBoardId: args.boardId, targetColumnId: args.columnId })
      : await ctx.api(ctx.auth, 'PATCH', `/cards/${cardId}`, { columnId: args.columnId });
    if (!result.ok) return fail(apiErrorMessage(result));
    return { ok: true, summary: `Moved "${text(record(result.body.card).title, 300)}".`, ref: cardId };
  },
};

const commentOnCard: AgentAction = {
  name: 'comment_on_card',
  kind: 'write',
  signature: 'comment_on_card {card, text}',
  description: 'Add a comment to a card.',
  schedulable: true,
  permission: { action: 'work.card_comments.create', resourceType: 'work.card_comment' },
  async prepare(ctx, args) {
    const body = longText(args.text, 4000);
    if (!body) return fail('The comment is empty.');
    const card = await cardRefOrResolve(ctx, args.card);
    if ('error' in card) return fail(card.error);
    return { ok: true, args: { cardId: card.ref, body }, summary: `Comment on ${card.label}: "${body.slice(0, 120)}"` };
  },
  async run(ctx, args) {
    const result = await ctx.api(ctx.auth, 'POST', `/cards/${String(args.cardId)}/comments`, { body: args.body });
    if (!result.ok) return fail(apiErrorMessage(result));
    return { ok: true, summary: 'Comment added.', ref: String(args.cardId) };
  },
};

const assignCard: AgentAction = {
  name: 'assign_card',
  kind: 'write',
  signature: 'assign_card {card, person}',
  description: 'Assign a teammate (or "me") to a card.',
  schedulable: true,
  permission: { action: 'work.card_assignees.create', resourceType: 'work.card_assignee' },
  available: (ctx) => Boolean(ctx.listMembers),
  async prepare(ctx, args) {
    const card = await cardRefOrResolve(ctx, args.card);
    if ('error' in card) return fail(card.error);
    const member = await resolveMember(ctx, args.person);
    if ('error' in member) return fail(member.error);
    return { ok: true, args: { cardId: card.ref, userId: member.userId, name: memberName(member) }, summary: `Assign ${memberName(member)} to ${card.label}` };
  },
  async run(ctx, args) {
    const result = await ctx.api(ctx.auth, 'POST', `/cards/${String(args.cardId)}/assignees`, { userId: args.userId });
    if (!result.ok) return fail(apiErrorMessage(result));
    return { ok: true, summary: `Assigned ${text(args.name, 200)}.`, ref: String(args.cardId) };
  },
};

const startTimer: AgentAction = {
  name: 'start_timer',
  kind: 'write',
  signature: 'start_timer {card}',
  description: 'Start your timer on a card. Stops any timer you have running first.',
  schedulable: true,
  permission: { action: 'work.time_entries.create', resourceType: 'work.time_entry' },
  async prepare(ctx, args) {
    const card = await cardRefOrResolve(ctx, args.card);
    if ('error' in card) return fail(card.error);
    return { ok: true, args: { cardId: card.ref, label: card.label }, summary: `Start your timer on ${card.label}` };
  },
  async run(ctx, args) {
    const cardId = String(args.cardId);
    const running = await runningTimers(ctx);
    if ('error' in running) return fail(running.error);
    if (running.rows.some((row) => row.cardId === cardId)) {
      return { ok: true, summary: 'Your timer was already running on that card.', ref: cardId };
    }
    for (const row of running.rows) {
      const stopped = await stopTimer(ctx, row);
      if (!stopped.ok) return fail(`I could not stop your running timer first: ${apiErrorMessage(stopped)}`);
    }
    const result = await ctx.api(ctx.auth, 'POST', `/cards/${cardId}/time-entries`, {
      seconds: 0,
      startedAt: new Date().toISOString(),
      note: 'Started by KODEX',
    });
    if (!result.ok) return fail(apiErrorMessage(result));
    const entry = record(result.body.timeEntry);
    if (entry.endedAt) {
      return fail('The timer closed straight away because it is past the 18:00 Africa/Harare cutoff.');
    }
    const stoppedNote = running.rows.length ? ' Your previous timer was stopped first.' : '';
    return { ok: true, summary: `Timer started on ${text(args.label, 300) || 'the card'}.${stoppedNote}`, ref: cardId };
  },
};

const stopTimerAction: AgentAction = {
  name: 'stop_timer',
  kind: 'write',
  signature: 'stop_timer {}',
  description: 'Stop your running timer.',
  schedulable: true,
  permission: { action: 'work.time_entries.update', resourceType: 'work.time_entry' },
  async prepare() {
    return { ok: true, args: {}, summary: 'Stop your running timer' };
  },
  async run(ctx) {
    const running = await runningTimers(ctx);
    if ('error' in running) return fail(running.error);
    if (running.rows.length === 0) return { ok: true, summary: 'No timer was running.' };
    for (const row of running.rows) {
      const stopped = await stopTimer(ctx, row);
      if (!stopped.ok) return fail(apiErrorMessage(stopped));
    }
    return { ok: true, summary: 'Timer stopped.' };
  },
};

const logTime: AgentAction = {
  name: 'log_time',
  kind: 'write',
  signature: 'log_time {card, minutes, note?, reason?}',
  description: 'Add manual time that ends now. When manual entries are switched off a reason is required and an approver must accept it.',
  schedulable: false,
  permission: { action: 'work.time_entries.create', resourceType: 'work.time_entry' },
  async prepare(ctx, args) {
    const minutes = Math.round(Number(args.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) return fail('Manual time must be between 1 minute and 24 hours.');
    const card = await cardRefOrResolve(ctx, args.card);
    if ('error' in card) return fail(card.error);
    const reason = longText(args.reason, 1000);
    const policy = await ctx.api(ctx.auth, 'GET', '/time-entries/manual-policy');
    const approval = policy.ok && record(policy.body.access).mode === 'approval';
    if (approval && reason.length < MANUAL_ENTRY_REASON_MIN_LENGTH) {
      return fail(
        `Manual entries are switched off, so this needs an approver. Tell me the reason (at least ${MANUAL_ENTRY_REASON_MIN_LENGTH} characters) and I will send it for approval.`,
      );
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const amount = [hours ? `${hours}h` : '', rest ? `${rest}m` : ''].filter(Boolean).join(' ');
    return {
      ok: true,
      args: { cardId: card.ref, minutes, note: longText(args.note, 500) || 'Logged by KODEX', reason: reason || null },
      summary: approval
        ? `Send ${amount} of manual time on ${card.label} for approval (reason: "${reason.slice(0, 120)}")`
        : `Add ${amount} of manual time on ${card.label}`,
    };
  },
  async run(ctx, args) {
    const seconds = Number(args.minutes) * 60;
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - seconds * 1000);
    const result = await ctx.api(ctx.auth, 'POST', `/cards/${String(args.cardId)}/time-entries`, {
      seconds,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      note: args.note,
      ...(args.reason ? { reason: args.reason } : {}),
    });
    if (result.status === 202) {
      return { ok: true, summary: 'Manual entries are switched off, so the time was sent for approval. It counts once an approver accepts it.' };
    }
    if (!result.ok) {
      const code = text(record(result.body.error).code, 80);
      if (code === 'MANUAL_ENTRY_APPROVAL_REQUIRED') {
        return fail('Manual entries are switched off. Tell me a reason (at least 15 characters) and I will send it for approval.');
      }
      return fail(apiErrorMessage(result));
    }
    return { ok: true, summary: `Added ${Number(args.minutes)} minutes of manual time.`, ref: String(args.cardId) };
  },
};

const createTicket: AgentAction = {
  name: 'create_ticket',
  kind: 'write',
  signature: 'create_ticket {subject, description, category?, priority?}',
  description: 'Open a support ticket. priority: low, medium, high or urgent.',
  schedulable: true,
  permission: { action: 'tickets.create', resourceType: 'ticket' },
  async prepare(_ctx, args) {
    const subject = text(args.subject, 300);
    const description = longText(args.description, 8000);
    if (!subject || !description) return fail('A ticket needs a subject and a description.');
    const priority = ['low', 'medium', 'high', 'urgent'].includes(text(args.priority).toLowerCase())
      ? text(args.priority).toLowerCase()
      : 'medium';
    const category = text(args.category, 80) || 'general';
    return {
      ok: true,
      args: { subject, description, category, priority },
      summary: `Open a ${priority} priority ${category} ticket: "${subject}"`,
    };
  },
  async run(ctx, args) {
    const result = await ctx.api(ctx.auth, 'POST', '/tickets', args);
    if (!result.ok) return fail(apiErrorMessage(result));
    const ticket = record(result.body.ticket);
    return { ok: true, summary: `Ticket "${text(ticket.subject, 300)}" opened.`, ref: text(ticket.id, 64) };
  },
};

const requestLeave: AgentAction = {
  name: 'request_leave',
  kind: 'write',
  signature: 'request_leave {startDate, endDate, reason?}',
  description: 'Submit a leave request. Dates are YYYY-MM-DD.',
  schedulable: false,
  permission: { action: 'leave.request', resourceType: 'leave' },
  async prepare(_ctx, args) {
    const startDate = parseDateOnly(args.startDate);
    const endDate = parseDateOnly(args.endDate ?? args.startDate);
    if (!startDate || !endDate) return fail('Leave dates must be real dates.');
    if (endDate < startDate) return fail('The leave end date is before the start date.');
    const reason = longText(args.reason, 1000);
    return {
      ok: true,
      args: { startDate, endDate, ...(reason ? { reason } : {}) },
      summary: `Request leave from ${startDate} to ${endDate}${reason ? ` (${reason.slice(0, 80)})` : ''}`,
    };
  },
  async run(ctx, args) {
    const result = await ctx.api(ctx.auth, 'POST', '/leave/requests', args);
    if (!result.ok) return fail(apiErrorMessage(result));
    const request = record(result.body.request);
    const days = request.requested_days ?? request.requestedDays;
    return { ok: true, summary: `Leave requested${days ? ` (${String(days)} day(s))` : ''}. It is waiting for approval.` };
  },
};

const clockIn: AgentAction = {
  name: 'clock_in',
  kind: 'write',
  signature: 'clock_in {}',
  description: 'Clock in for today. Offices with a location fence still require the app.',
  schedulable: false,
  permission: { action: 'attendance.clock', resourceType: 'attendance' },
  async prepare() {
    return { ok: true, args: {}, summary: 'Clock you in now' };
  },
  async run(ctx) {
    const active = await ctx.api(ctx.auth, 'GET', '/attendance/active');
    if (active.ok && active.body.session) return { ok: true, summary: 'You were already clocked in.' };
    const result = await ctx.api(ctx.auth, 'POST', '/attendance/clock-in', { method: 'kodex' });
    if (!result.ok) {
      const message = apiErrorMessage(result);
      return fail(/location|area|geofence/i.test(message) ? `${message} Clock in from the app so your location can be checked.` : message);
    }
    return { ok: true, summary: `Clocked in at ${formatWhen(new Date())}.` };
  },
};

const clockOut: AgentAction = {
  name: 'clock_out',
  kind: 'write',
  signature: 'clock_out {}',
  description: 'Clock out now.',
  schedulable: false,
  permission: { action: 'attendance.clock', resourceType: 'attendance' },
  async prepare() {
    return { ok: true, args: {}, summary: 'Clock you out now' };
  },
  async run(ctx) {
    const active = await ctx.api(ctx.auth, 'GET', '/attendance/active');
    if (!active.ok) return fail(apiErrorMessage(active));
    const session = record(active.body.session);
    if (!session.id) return { ok: true, summary: 'You were not clocked in.' };
    const result = await ctx.api(ctx.auth, 'POST', `/attendance/sessions/${text(session.id, 64)}/clock-out`, { method: 'kodex' });
    if (!result.ok) return fail(apiErrorMessage(result));
    return { ok: true, summary: `Clocked out at ${formatWhen(new Date())}.` };
  },
};

const bookShoot: AgentAction = {
  name: 'book_shoot',
  kind: 'write',
  signature: 'book_shoot {title, location, startsAt, endsAt, vehicle?, otherTransport?, clientName?, notes?}',
  description: 'Request a shoot booking. vehicle is a fleet vehicle name; otherwise describe otherTransport.',
  schedulable: false,
  permission: { action: 'media.manage', resourceType: 'media' },
  async prepare(ctx, args) {
    const title = text(args.title, 300);
    const location = text(args.location, 500);
    const startsAt = parseInstant(args.startsAt);
    const endsAt = parseInstant(args.endsAt);
    if (!title || !location) return fail('A shoot booking needs a title and a location.');
    if (!startsAt || !endsAt) return fail('A shoot booking needs a start and end time.');
    if (endsAt <= startsAt) return fail('The shoot must end after it starts.');
    let vehicleId: string | null = null;
    let vehicleLabel = text(args.otherTransport, 200);
    if (text(args.vehicle)) {
      const result = await ctx.api(ctx.auth, 'GET', '/media/vehicles?limit=100');
      if (!result.ok) return fail(apiErrorMessage(result));
      const vehicles = list(result.body.vehicles).map((v) => ({
        id: text(v.id, 64),
        name: text(v.vehicle_name ?? v.name, 200),
        registration: text(v.registration_number ?? v.registration, 60),
      }));
      const picked = pickByName(vehicles, text(args.vehicle), (v) => [v.name, v.registration]);
      if (picked === 'none' || picked === 'many') {
        return fail(`I could not match the vehicle "${text(args.vehicle)}". Vehicles: ${vehicles.map((v) => v.name).join(', ') || 'none'}.`);
      }
      vehicleId = picked.id;
      vehicleLabel = picked.registration && picked.registration !== picked.name ? `${picked.name} ${picked.registration}` : picked.name;
    }
    if (!vehicleId && !vehicleLabel) return fail('Tell me which vehicle, or describe the other transport.');
    return {
      ok: true,
      args: {
        title,
        location,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        vehicleId: vehicleId ?? '__other__',
        ...(vehicleId ? {} : { vehicleOther: vehicleLabel }),
        ...(text(args.clientName) ? { clientName: text(args.clientName, 300) } : {}),
        ...(longText(args.notes) ? { notes: longText(args.notes) } : {}),
      },
      summary: `Book shoot "${title}" at ${location}, ${formatWhen(startsAt)} to ${formatWhen(endsAt)}, transport: ${vehicleLabel}`,
    };
  },
  async run(ctx, args) {
    const result = await ctx.api(ctx.auth, 'POST', '/media/shoot-bookings', args);
    if (!result.ok) return fail(apiErrorMessage(result));
    return { ok: true, summary: 'Shoot booking requested. It is waiting for approval.', ref: text(result.body.id, 64) };
  },
};

const remindMe: AgentAction = {
  name: 'remind_me',
  kind: 'write',
  signature: 'remind_me {text}',
  description: 'Send yourself a reminder. Needs "at".',
  schedulable: true,
  scheduledOnly: true,
  async prepare(_ctx, args) {
    const body = text(args.text, 500);
    if (!body) return fail('What should I remind you about?');
    return { ok: true, args: { text: body }, summary: `Remind you: "${body}"` };
  },
  async run(ctx, args) {
    const body = text(args.text, 500);
    await ctx.notify?.({ auth: ctx.auth, title: 'KODEX reminder', message: body });
    return { ok: true, summary: `Reminder: ${body}` };
  },
};

const cancelScheduled: AgentAction = {
  name: 'cancel_scheduled',
  kind: 'write',
  signature: 'cancel_scheduled {id}',
  description: 'Cancel one of your scheduled KODEX tasks (id from list_scheduled).',
  schedulable: false,
  available: (ctx) => Boolean(ctx.store),
  async prepare(ctx, args) {
    const id = text(args.id, 64);
    if (!UUID.test(id) || !ctx.store) return fail('Tell me which scheduled task to cancel.');
    const rows = await ctx.store.listScheduledActions(ctx.auth.membership.organizationId, ctx.auth.actor.userId);
    const row = rows.find((item) => item.id === id);
    if (!row || row.status !== 'scheduled') return fail('That scheduled task is not waiting to run.');
    return { ok: true, args: { id }, summary: `Cancel scheduled task: ${row.summary} at ${formatWhen(row.runAt)}` };
  },
  async run(ctx, args) {
    if (!ctx.store) return fail('Scheduling is not available.');
    const result = await ctx.store.cancelScheduledAction(ctx.auth.membership.organizationId, ctx.auth.actor.userId, String(args.id));
    if (!result || result === 'not_scheduled') return fail('That scheduled task is not waiting to run.');
    return { ok: true, summary: 'Scheduled task cancelled.' };
  },
};

export const AGENT_ACTIONS: AgentAction[] = [
  findCards,
  boardOverview,
  myTimers,
  findPeople,
  listScheduled,
  webSearch,
  readWebpage,
  createCard,
  updateCard,
  moveCard,
  commentOnCard,
  assignCard,
  startTimer,
  stopTimerAction,
  logTime,
  createTicket,
  requestLeave,
  clockIn,
  clockOut,
  bookShoot,
  remindMe,
  cancelScheduled,
];

export function findAction(name: string) {
  return AGENT_ACTIONS.find((action) => action.name === name) ?? null;
}

export function actionAllowed(ctx: AgentContext, action: AgentAction) {
  if (action.available && !action.available(ctx)) return false;
  if (!action.permission) return true;
  return authorize({
    context: ctx.auth,
    action: action.permission.action,
    resource: { type: action.permission.resourceType, organizationId: ctx.auth.membership.organizationId },
  }).allowed;
}

export function availableActions(ctx: AgentContext) {
  return AGENT_ACTIONS.filter((action) => actionAllowed(ctx, action));
}
