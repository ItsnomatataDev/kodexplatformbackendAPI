import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Hono } from 'hono';
import { MemoryFileStorage } from '../src/files/memory-storage.js';
import { NotFoundError } from '../src/http/errors.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { createAiRoutes } from '../src/routes/ai.js';
import type { AuthContext } from '../src/authorization/types.js';
import { claimInternalAuth, createInternalApi, KODEX_INTERNAL_HEADER, type ApiResult, type InternalApi } from '../src/ai/agent/internal-api.js';
import { availableActions, type AgentContext } from '../src/ai/agent/actions.js';
import { buildAgentInstructions, executePlanSteps, extractActionBlock, preparePlan } from '../src/ai/agent/planner.js';
import { runDueScheduledActions, type AgentRuntime } from '../src/ai/agent/service.js';
import { MemoryAgentStore } from '../src/ai/agent/store.js';
import { compactHistory, planReplyIntent, quickTimeSteps, rememberResults } from '../src/ai/agent/turn.js';
import { htmlToText, isBlockedAddress, readWebPage } from '../src/ai/agent/web.js';
import '../src/types/hono.js';

const orgId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const userId = '11111111-1111-1111-1111-111111111111';
const teammateId = '22222222-2222-2222-2222-222222222222';
const boardId = 'b0000000-0000-4000-8000-000000000001';
const backlogId = 'c0000000-0000-4000-8000-000000000001';
const doneId = 'c0000000-0000-4000-8000-000000000002';
const homepageId = 'd0000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-18T10:00:00.000Z');

function authFor(overrides: Partial<AuthContext['membership']> = {}): AuthContext {
  return {
    actor: { userId, email: 'thando@example.com', isActive: true, accountStatus: 'active', deletedAt: null },
    membership: {
      membershipId: 'membership-1',
      organizationId: orgId,
      officeId: null,
      roleId: 'role-1',
      roleKey: 'admin',
      status: 'active',
      isAdminRole: true,
      isManagerRole: false,
      permissions: true,
      ...overrides,
    },
    organization: { organizationId: orgId, isActive: true, status: 'active', accessStatus: 'active' },
  } as AuthContext;
}

type FakeCard = { id: string; title: string; boardId: string; columnId: string };
type FakeEntry = { id: string; cardId: string; userId: string; startedAt: string; endedAt: string | null; seconds: number };

function fakeWorkspace(options: { manualMode?: 'direct' | 'approval' } = {}) {
  const cards: FakeCard[] = [{ id: homepageId, title: 'Homepage', boardId, columnId: backlogId }];
  const entries: FakeEntry[] = [];
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const ok = (body: Record<string, unknown>, status = 200): ApiResult => ({ status, ok: status < 400, body });
  const api: InternalApi = async (_auth, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/boards?')) {
      return ok({ boards: [{ id: boardId, name: 'Marketing', archivedAt: null }] });
    }
    if (method === 'GET' && path === `/boards/${boardId}/columns`) {
      return ok({
        columns: [
          { id: backlogId, name: 'Backlog', statusKey: 'backlog' },
          { id: doneId, name: 'Done', statusKey: 'done' },
        ],
      });
    }
    if (method === 'POST' && path === `/boards/${boardId}/cards`) {
      const card = { id: randomUUID(), title: String(body?.title), boardId, columnId: String(body?.columnId) };
      cards.push(card);
      return ok({ card }, 201);
    }
    const cardMatch = path.match(/^\/cards\/([0-9a-f-]{36})$/);
    if (cardMatch && method === 'GET') {
      const card = cards.find((item) => item.id === cardMatch[1]);
      return card ? ok({ card }) : ok({ error: { message: 'The card was not found.' } }, 404);
    }
    if (cardMatch && method === 'PATCH') {
      const card = cards.find((item) => item.id === cardMatch[1]);
      if (!card) return ok({ error: { message: 'The card was not found.' } }, 404);
      if (body?.columnId) card.columnId = String(body.columnId);
      return ok({ card });
    }
    if (method === 'GET' && path === '/time-entries/running') {
      return ok({ timeEntries: entries.filter((entry) => !entry.endedAt) });
    }
    if (method === 'GET' && path.startsWith('/time-entries/manual-policy')) {
      return ok({ access: { mode: options.manualMode ?? 'direct' } });
    }
    const timeMatch = path.match(/^\/cards\/([0-9a-f-]{36})\/time-entries$/);
    if (timeMatch && method === 'POST') {
      if (options.manualMode === 'approval' && body?.endedAt) {
        return body.reason ? ok({ pendingApproval: true }, 202) : ok({ error: { code: 'MANUAL_ENTRY_APPROVAL_REQUIRED', message: 'Reason required.' } }, 403);
      }
      const entry: FakeEntry = {
        id: randomUUID(),
        cardId: timeMatch[1],
        userId,
        startedAt: String(body?.startedAt ?? new Date().toISOString()),
        endedAt: (body?.endedAt as string | undefined) ?? null,
        seconds: Number(body?.seconds ?? 0),
      };
      entries.push(entry);
      return ok({ timeEntry: entry }, 201);
    }
    const entryMatch = path.match(/^\/time-entries\/([0-9a-f-]{36})$/);
    if (entryMatch && method === 'PATCH') {
      const entry = entries.find((item) => item.id === entryMatch[1]);
      if (!entry) return ok({}, 404);
      entry.endedAt = String(body?.endedAt);
      entry.seconds = Number(body?.seconds ?? 0);
      return ok({ timeEntry: entry });
    }
    if (method === 'GET' && path === '/attendance/active') return ok({ session: null });
    return ok({ error: { message: `unexpected ${method} ${path}` } }, 500);
  };
  return { api, cards, entries, calls };
}

function contextFor(workspace: ReturnType<typeof fakeWorkspace>, store = new MemoryAgentStore(), auth = authFor()): AgentContext {
  return {
    auth,
    api: workspace.api,
    now: NOW,
    store,
    findCards: async (_org, query) =>
      workspace.cards
        .filter((card) => card.title.toLowerCase().includes(query.toLowerCase()))
        .map((card) => ({ id: card.id, title: card.title, boardName: 'Marketing' })),
    listMembers: async () => [
      { userId, fullName: 'Thando Mpofu', email: 'thando@example.com', roleKey: 'admin' },
      { userId: teammateId, fullName: 'Rudo Moyo', email: 'rudo@example.com', roleKey: 'staff' },
    ],
  };
}

const CREATE_AND_SCHEDULE = [
  'I will create the card and start your timer at 15:00.',
  '```kodex-actions',
  '{"steps":[{"id":"s1","action":"create_card","args":{"title":"Website audit","board":"marketing","column":"Backlog"}},{"id":"s2","action":"start_timer","args":{"card":"$s1"},"at":"2026-11-18T15:00:00+02:00"}]}',
  '```',
].join('\n');

test('a fenced kodex-actions block is split from the reply and thinking is dropped', () => {
  const parsed = extractActionBlock(`<think>plan it</think>${CREATE_AND_SCHEDULE}`);
  assert.equal(parsed.reply, 'I will create the card and start your timer at 15:00.');
  assert.equal(parsed.steps?.length, 2);
  assert.deepEqual(parsed.steps?.[1], { id: 's2', action: 'start_timer', args: { card: '$s1' }, at: '2026-11-18T15:00:00+02:00' });
  assert.deepEqual(extractActionBlock('Just a normal answer.'), { reply: 'Just a normal answer.', steps: null });
});

test('create card then a scheduled timer resolves names and keeps the step reference', async () => {
  const workspace = fakeWorkspace();
  const prepared = await preparePlan(contextFor(workspace), extractActionBlock(CREATE_AND_SCHEDULE).steps!);
  assert.deepEqual(prepared.errors, []);
  assert.equal(prepared.steps.length, 2);
  assert.deepEqual(prepared.steps[0].args, { boardId, columnId: backlogId, title: 'Website audit', description: null, dueAt: null, priority: null });
  assert.equal(prepared.steps[0].runAt, null);
  assert.equal(prepared.steps[1].args.cardId, '$s1');
  assert.equal(prepared.steps[1].runAt, '2026-11-18T13:00:00.000Z');
  assert.match(prepared.steps[0].summary, /Website audit.*Marketing › Backlog/);
  assert.equal(workspace.calls.some((call) => call.method !== 'GET'), false, 'preparing must not write');
});

test('executing the plan creates the card now and schedules the timer for the new card', async () => {
  const workspace = fakeWorkspace();
  const store = new MemoryAgentStore();
  const ctx = contextFor(workspace, store);
  const prepared = await preparePlan(ctx, extractActionBlock(CREATE_AND_SCHEDULE).steps!);
  const { results, failed } = await executePlanSteps(ctx, prepared.steps, { store, threadId: null, planId: null });
  assert.equal(failed, false);
  assert.deepEqual(results.map((result) => result.status), ['done', 'scheduled']);
  const created = workspace.cards.find((card) => card.title === 'Website audit');
  assert.ok(created);
  assert.equal(store.scheduled.length, 1);
  assert.equal(store.scheduled[0].action, 'start_timer');
  assert.equal(store.scheduled[0].args.cardId, created.id);
  assert.equal(store.scheduled[0].runAt.toISOString(), '2026-11-18T13:00:00.000Z');
});

test('invalid plans are rejected before anything is shown for confirmation', async () => {
  const ctx = contextFor(fakeWorkspace());
  const prepared = await preparePlan(ctx, [
    { id: 's1', action: 'clock_in', args: {}, at: '2026-11-18T16:00:00+02:00' },
    { id: 's2', action: 'start_timer', args: { card: 'Homepage' }, at: '2026-11-18T08:00:00+02:00' },
    { id: 's3', action: 'delete_everything', args: {}, at: null },
    { id: 's4', action: 'log_time', args: { card: 'Homepage', minutes: 60 }, at: '2026-11-18T17:00:00+02:00' },
    { id: 's5', action: 'remind_me', args: { text: 'call Rudo' }, at: null },
    { id: 's6', action: 'start_timer', args: { card: 'Nope' }, at: null },
  ]);
  assert.equal(prepared.steps.length, 0);
  assert.equal(prepared.errors.length, 6);
  assert.match(prepared.errors[0], /cannot be scheduled/);
  assert.match(prepared.errors[1], /already passed/);
  assert.match(prepared.errors[2], /do not have an action/);
  assert.match(prepared.errors[3], /cannot be scheduled/);
  assert.match(prepared.errors[4], /when the reminder/);
  assert.match(prepared.errors[5], /could not find an open card/);
});

test('a step cannot use the card from a step that is itself scheduled', async () => {
  const prepared = await preparePlan(contextFor(fakeWorkspace()), [
    { id: 's1', action: 'create_card', args: { title: 'Later card', board: 'Marketing' }, at: '2026-11-18T14:00:00+02:00' },
    { id: 's2', action: 'start_timer', args: { card: '$s1' }, at: '2026-11-18T15:00:00+02:00' },
  ]);
  assert.equal(prepared.steps.length, 1);
  assert.match(prepared.errors[0], /runs straight away/);
});

test('manual time needs a reason when manual entries are switched off', async () => {
  const ctx = contextFor(fakeWorkspace({ manualMode: 'approval' }));
  const missing = await preparePlan(ctx, [{ id: 's1', action: 'log_time', args: { card: 'Homepage', minutes: 90 }, at: null }]);
  assert.match(missing.errors[0], /needs an approver/);
  const withReason = await preparePlan(ctx, [
    { id: 's1', action: 'log_time', args: { card: 'Homepage', minutes: 90, reason: 'Client shoot in Borrowdale all morning' }, at: null },
  ]);
  assert.deepEqual(withReason.errors, []);
  assert.match(withReason.steps[0].summary, /for approval/);
  const outcome = await executePlanSteps(ctx, withReason.steps, { store: new MemoryAgentStore(), threadId: null, planId: null });
  assert.match(outcome.results[0].summary, /sent for approval/);
});

test('a role without the permission does not see or get the action', async () => {
  const auth = authFor({ roleKey: 'member', isAdminRole: false, permissions: { work: { cards: { read: true } } } });
  const ctx = { ...contextFor(fakeWorkspace()), auth };
  const names = availableActions(ctx).map((action) => action.name);
  assert.equal(names.includes('create_card'), false);
  assert.equal(names.includes('start_timer'), false);
  assert.equal(buildAgentInstructions(ctx).includes('create_card'), false);
  const prepared = await preparePlan(ctx, [{ id: 's1', action: 'create_card', args: { title: 'X', board: 'Marketing' }, at: null }]);
  assert.match(prepared.errors[0], /cannot use create card/);
});

test('due scheduled timer stops the running timer, starts the new one and reports back', async () => {
  const workspace = fakeWorkspace();
  workspace.entries.push({ id: randomUUID(), cardId: homepageId, userId, startedAt: '2026-11-18T11:00:00.000Z', endedAt: null, seconds: 0 });
  const store = new MemoryAgentStore();
  const otherCard = { id: randomUUID(), title: 'Website audit', boardId, columnId: backlogId };
  workspace.cards.push(otherCard);
  await store.createScheduledAction({
    organizationId: orgId,
    userId,
    threadId: 'thread-1',
    planId: null,
    action: 'start_timer',
    args: { cardId: otherCard.id, label: '"Website audit"' },
    summary: 'Start your timer on "Website audit"',
    runAt: new Date('2026-11-18T13:00:00.000Z'),
  });
  const posted: string[] = [];
  const notified: string[] = [];
  const rt: AgentRuntime = {
    api: workspace.api,
    store,
    threads: {
      addMessage: async (_o, _u, _t, input) => {
        posted.push(input.content);
        return { id: randomUUID(), created_at: null, metadata: input.metadata ?? {} };
      },
      getThread: async () => ({ metadata: {} }),
      updateThread: async () => undefined,
      updateMessageMetadata: async () => undefined,
    },
    resolveAuth: async () => authFor(),
    findCards: async () => [],
    notify: async (input) => {
      notified.push(input.title);
    },
  };
  assert.deepEqual(await runDueScheduledActions(new Date('2026-11-18T12:59:00.000Z'), rt), { ran: 0 });
  assert.deepEqual(await runDueScheduledActions(new Date('2026-11-18T13:00:30.000Z'), rt), { ran: 1 });
  assert.equal(store.scheduled[0].status, 'done');
  assert.equal(workspace.entries[0].endedAt !== null, true, 'previous timer stopped');
  assert.equal(workspace.entries[1].cardId, otherCard.id);
  assert.equal(workspace.entries[1].endedAt, null);
  assert.match(posted[0], /ran: Timer started on "Website audit"\. Your previous timer was stopped first\./);
  assert.deepEqual(notified, ['KODEX finished a task']);
});

test('a scheduled action fails cleanly when the owner lost access', async () => {
  const store = new MemoryAgentStore();
  await store.createScheduledAction({
    organizationId: orgId,
    userId,
    threadId: null,
    planId: null,
    action: 'stop_timer',
    args: {},
    summary: 'Stop your running timer',
    runAt: new Date('2026-11-18T09:00:00.000Z'),
  });
  const rt = {
    api: fakeWorkspace().api,
    store,
    threads: {} as AgentRuntime['threads'],
    resolveAuth: async () => {
      throw new Error('Account is inactive.');
    },
    findCards: async () => [],
  } satisfies AgentRuntime;
  await runDueScheduledActions(NOW, rt);
  assert.equal(store.scheduled[0].status, 'failed');
  assert.equal(store.scheduled[0].error, 'Account is inactive.');
});

test('simple timer requests skip the model; scheduled or compound ones do not', () => {
  assert.deepEqual(quickTimeSteps('start my timer on Homepage'), [{ id: 's1', action: 'start_timer', args: { card: 'Homepage' }, at: null }]);
  assert.deepEqual(quickTimeSteps('log 2 hours on Homepage'), [{ id: 's1', action: 'log_time', args: { card: 'Homepage', minutes: 120 }, at: null }]);
  assert.equal(quickTimeSteps('start my timer on Homepage at 3pm'), null);
  assert.equal(quickTimeSteps('create a card called Audit and start my timer on it'), null);
  assert.equal(quickTimeSteps('what is the weather'), null);
});

test('short yes and no replies are read as plan decisions', () => {
  assert.equal(planReplyIntent('yes'), 'confirm');
  assert.equal(planReplyIntent('Go ahead please'), 'confirm');
  assert.equal(planReplyIntent('okay kodex'), 'confirm');
  assert.equal(planReplyIntent('no'), 'cancel');
  assert.equal(planReplyIntent('cancel that'), null);
  assert.equal(planReplyIntent('yes but move it to Done instead and add a comment'), null);
});

test('long chats keep the newest turns and list older user requests', () => {
  const turns = Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${index % 2 === 0 ? 'question' : 'answer'} ${index} ${'x'.repeat(200)}`,
  }));
  const compacted = compactHistory(turns, 2_000);
  assert.ok(compacted.turns.length < turns.length);
  assert.equal(compacted.turns[0].role, 'user');
  assert.equal(compacted.turns.at(-1)?.content, turns.at(-1)?.content);
  assert.ok(compacted.earlierTopics.length > 0);
  assert.match(compacted.earlierTopics[0], /^- question 0/);
});

test('memory keeps the ids of what KODEX did', () => {
  const memory = rememberResults(
    [],
    [{ id: 's1', action: 'create_card', args: {}, summary: 'Create card "Audit" on Marketing › Backlog', runAt: null }],
    [{ id: 's1', status: 'done', summary: 'Created card "Audit".', ref: homepageId }],
    NOW,
  );
  assert.equal(memory.length, 1);
  assert.match(memory[0], /Create card "Audit".*\(id d0000000/);
});

test('internal API grants are single use and carry the caller auth', async () => {
  const auth = authFor();
  const app = new Hono();
  let seen: AuthContext | null = null;
  let replayed: AuthContext | null = null;
  app.post('/api/echo', async (c) => {
    const token = c.req.header(KODEX_INTERNAL_HEADER);
    seen = claimInternalAuth(token);
    replayed = claimInternalAuth(token);
    return c.json({ ok: true, body: await c.req.json() });
  });
  const api = createInternalApi(app);
  const result = await api(auth, 'POST', '/echo', { hello: 'world' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.body, { hello: 'world' });
  assert.equal(seen, auth);
  assert.equal(replayed, null);
  assert.equal(claimInternalAuth('made-up-token'), null);
});

test('web reading refuses private networks and extracts page text', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.111', '100.114.136.14', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  await assert.rejects(readWebPage('http://127.0.0.1/admin'), /Private network/);
  await assert.rejects(readWebPage('http://localhost:3100/'), /standard web ports|Private network/);
  await assert.rejects(readWebPage('file:///etc/passwd'), /Only http and https/);
  const page = htmlToText('<html><head><title>Hi &amp; bye</title><script>evil()</script></head><body><p>Hello</p><p>World</p></body></html>');
  assert.equal(page.title, 'Hi & bye');
  assert.equal(page.text, 'Hello\nWorld');
});

// --- Chat route ---------------------------------------------------------------

function memoryAiStore() {
  const threads: Array<{ id: string; organization_id: string; user_id: string; title: string; metadata: Record<string, unknown>; created_at: string; updated_at: string }> = [];
  const messages: Array<{ id: string; thread_id: string; role: string; content: string; metadata: Record<string, unknown>; created_at: string }> = [];
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++)).toISOString();
  const getThread = async (organizationId: string, owner: string, threadId: string) => {
    const thread = threads.find((row) => row.id === threadId && row.organization_id === organizationId && row.user_id === owner);
    if (!thread) throw new NotFoundError('AI_THREAD_NOT_FOUND', 'Chat thread not found.');
    return thread;
  };
  return {
    messages,
    getAssistant: async () => null,
    listThreads: async (organizationId: string, owner: string) => {
      const rows = threads.filter((row) => row.organization_id === organizationId && row.user_id === owner);
      return { threads: rows.slice(-1), total: rows.length };
    },
    createThread: async (organizationId: string, owner: string, input: { title?: string; metadata?: Record<string, unknown> }) => {
      const thread = { id: randomUUID(), organization_id: organizationId, user_id: owner, title: input.title ?? 'New chat', metadata: input.metadata ?? {}, created_at: stamp(), updated_at: stamp() };
      threads.push(thread);
      return thread;
    },
    getThread,
    updateThread: async (organizationId: string, owner: string, threadId: string, patch: { metadata?: Record<string, unknown> }) => {
      const thread = await getThread(organizationId, owner, threadId);
      if (patch.metadata) thread.metadata = patch.metadata;
      return thread;
    },
    listMessages: async (organizationId: string, owner: string, threadId: string, options?: { limit?: number }) => {
      await getThread(organizationId, owner, threadId);
      return messages.filter((row) => row.thread_id === threadId).slice(-(options?.limit ?? 100));
    },
    addMessage: async (organizationId: string, owner: string, threadId: string, input: { role: string; content: string; metadata?: Record<string, unknown> }) => {
      await getThread(organizationId, owner, threadId);
      const row = { id: randomUUID(), thread_id: threadId, role: input.role, content: input.content, metadata: input.metadata ?? {}, created_at: stamp() };
      messages.push(row);
      return row;
    },
    updateMessageMetadata: async (_organizationId: string, threadId: string, messageId: string, patch: Record<string, unknown>) => {
      const row = messages.find((item) => item.id === messageId && item.thread_id === threadId);
      if (row) row.metadata = { ...row.metadata, ...patch };
    },
  };
}

function chatApp(replies: string[]) {
  const workspace = fakeWorkspace();
  const store = memoryAiStore();
  const agentStore = new MemoryAgentStore();
  const prompts: Array<Array<{ role: string; content: string }>> = [];
  const ctxBase = contextFor(workspace, agentStore);
  const agent: AgentRuntime = {
    api: workspace.api,
    store: agentStore,
    threads: store as never,
    resolveAuth: async () => authFor(),
    findCards: ctxBase.findCards,
    listMembers: ctxBase.listMembers,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authFor());
    await next();
  });
  app.onError(errorHandler);
  app.route('/api/ai', createAiRoutes({
    store: store as never,
    files: new MemoryFileStorage(),
    agent,
    workspaceGatewayChat: { enabled: false, chatMessages: async () => ({ message: '' }) },
    llmChatCompletions: async (input) => {
      prompts.push(input.messages as Array<{ role: string; content: string }>);
      const content = replies.shift() ?? 'Okay.';
      return { choices: [{ message: { role: 'assistant', content } }] };
    },
  }));
  const post = (path: string, body: Record<string, unknown> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, post, workspace, store, agentStore, prompts };
}

test('chat proposes a plan, "yes" runs it, and the plan card records the outcome', async () => {
  const harness = chatApp([CREATE_AND_SCHEDULE]);
  const first = await harness.post('/api/ai/chat', {
    message: 'kodex create a card named Website audit in backlog on marketing then at 3pm start tracking time on it',
    newThread: true,
  });
  assert.equal(first.status, 200);
  const proposal = await first.json() as { threadId: string; reply: string; kodexPlan: { id: string; status: string; steps: unknown[] } };
  assert.equal(proposal.kodexPlan.status, 'pending');
  assert.equal(proposal.kodexPlan.steps.length, 2);
  assert.match(proposal.reply, /once you confirm/);
  assert.equal(harness.workspace.cards.some((card) => card.title === 'Website audit'), false, 'nothing written before confirmation');
  const system = harness.prompts[0][0].content;
  assert.match(system, /KODEX ACTIONS/);
  assert.match(system, /create_card \{title, board/);

  const second = await harness.post('/api/ai/chat', { message: 'yes', threadId: proposal.threadId });
  assert.equal(second.status, 200);
  const done = await second.json() as { reply: string };
  assert.match(done.reply, /All set/);
  assert.match(done.reply, /Scheduled for/);
  assert.equal(harness.prompts.length, 1, 'confirmation does not call the model');
  assert.ok(harness.workspace.cards.some((card) => card.title === 'Website audit'));
  assert.equal(harness.agentStore.scheduled.length, 1);
  const planMessage = harness.store.messages.find((row) => (row.metadata.kodexPlan as { id?: string } | undefined)?.id === proposal.kodexPlan.id);
  assert.equal((planMessage?.metadata.kodexPlan as { status: string }).status, 'completed');

  const again = await harness.post(`/api/ai/plans/${proposal.kodexPlan.id}/confirm`);
  assert.equal(again.status, 409);

  const scheduled = await harness.app.request('/api/ai/scheduled');
  const list = await scheduled.json() as { scheduled: Array<{ id: string; status: string }> };
  assert.equal(list.scheduled.length, 1);
  const cancelled = await harness.app.request(`/api/ai/scheduled/${list.scheduled[0].id}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal(harness.agentStore.scheduled[0].status, 'cancelled');
});

test('the cancel button cancels a pending plan without writing', async () => {
  const harness = chatApp([CREATE_AND_SCHEDULE]);
  const first = await harness.post('/api/ai/chat', { message: 'create a card and track it at 3pm', newThread: true });
  const proposal = await first.json() as { kodexPlan: { id: string } };
  const cancelled = await harness.post(`/api/ai/plans/${proposal.kodexPlan.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.match(((await cancelled.json()) as { reply: string }).reply, /Nothing was changed/);
  assert.equal(harness.workspace.cards.length, 1);
  assert.equal(harness.agentStore.scheduled.length, 0);
});

test('lookups run straight away and their results go back to the model', async () => {
  const harness = chatApp([
    'Let me check.\n```kodex-actions\n{"steps":[{"id":"s1","action":"my_timers","args":{}}]}\n```',
    'You have no timer running right now.',
  ]);
  const response = await harness.post('/api/ai/chat', { message: 'do I have a timer running?', newThread: true });
  const body = await response.json() as { reply: string; kodexPlan: unknown };
  assert.equal(body.reply, 'You have no timer running right now.');
  assert.equal(body.kodexPlan, null);
  assert.equal(harness.prompts.length, 2);
  const followUp = harness.prompts[1].at(-1)!;
  assert.equal(followUp.role, 'user');
  assert.match(followUp.content, /KODEX lookup results/);
  assert.match(followUp.content, /You have no timer running/);
});

test('a plain timer request is proposed without calling the model', async () => {
  const harness = chatApp([]);
  const response = await harness.post('/api/ai/chat', { message: 'start my timer on Homepage', newThread: true });
  const body = await response.json() as { reply: string; kodexPlan: { steps: Array<{ summary: string }> } };
  assert.equal(harness.prompts.length, 0);
  assert.match(body.kodexPlan.steps[0].summary, /Start your timer on "Homepage"/);
  assert.equal(harness.workspace.entries.length, 0);
});

test('an unavailable model returns 503 and stores no assistant reply', async () => {
  const harness = chatApp([]);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authFor());
    await next();
  });
  app.onError(errorHandler);
  app.route('/api/ai', createAiRoutes({
    store: harness.store as never,
    files: new MemoryFileStorage(),
    agent: { api: harness.workspace.api, store: harness.agentStore, threads: harness.store as never, resolveAuth: async () => authFor(), findCards: async () => [] },
    workspaceGatewayChat: { enabled: false, chatMessages: async () => ({ message: '' }) },
    llmChatCompletions: async () => {
      throw new Error('Internal LLM error (503): AI service temporarily unavailable.');
    },
  }));
  const response = await app.request('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello there', newThread: true }),
  });
  assert.equal(response.status, 503);
  assert.equal(harness.store.messages.filter((row) => row.role === 'assistant').length, 0);
  assert.equal(harness.store.messages.filter((row) => row.role === 'user').length, 1);
});
