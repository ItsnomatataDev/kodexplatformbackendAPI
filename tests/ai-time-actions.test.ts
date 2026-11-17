import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthContext } from '../src/authorization/types.js';
import { parseTimeRequest, resolveTimeChat, type TimeActionSource, type TimeCardMatch, type TimeRunningRow } from '../src/ai/time-actions.js';
import { buildWorkspaceBrief } from '../src/ai/workspace-brief.js';

const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const userId = '11111111-1111-1111-1111-111111111111';
const otherId = '22222222-2222-2222-2222-222222222222';

function auth(partial: {
  userId?: string;
  roleKey?: string;
  isAdminRole?: boolean;
  isManagerRole?: boolean;
  permissions?: Record<string, unknown>;
}): AuthContext {
  return {
    actor: {
      userId: partial.userId ?? userId,
      email: 'person@example.com',
      isActive: true,
      accountStatus: 'active',
      deletedAt: null,
    },
    membership: {
      membershipId: 'membership-1',
      organizationId: org,
      officeId: null,
      roleId: 'role-1',
      roleKey: partial.roleKey ?? 'media_team',
      status: 'active',
      isAdminRole: partial.isAdminRole ?? false,
      isManagerRole: partial.isManagerRole ?? false,
      permissions: partial.permissions ?? {
        work: { time_entries: { read: true, create: true } },
      },
    },
    organization: {
      organizationId: org,
      isActive: true,
      status: 'active',
      accessStatus: 'active',
    },
  };
}

function source(options: {
  running?: TimeRunningRow[];
  cards?: TimeCardMatch[];
} = {}) {
  const created: Array<Parameters<TimeActionSource['createEntry']>[0]> = [];
  const time: TimeActionSource = {
    async listRunning(_organizationId, requestedUserId) {
      const rows = options.running ?? [];
      if (!requestedUserId) return rows;
      return rows.filter((row) => row.userId === requestedUserId);
    },
    async findCards() {
      return options.cards ?? [];
    },
    async createEntry(input) {
      created.push(input);
      return { id: 'entry-1', endedAt: input.endedAt };
    },
  };
  return { time, created };
}

const homepage: TimeCardMatch = { id: 'card-1', title: 'Homepage', boardName: 'Web' };
const runningHomepage: TimeRunningRow = {
  id: 'run-1',
  cardId: 'card-1',
  cardTitle: 'Homepage',
  boardName: 'Web',
  userId,
  userName: 'You Person',
  startedAt: new Date('2026-11-10T08:00:00.000Z'),
  endedAt: null,
};

test('a normal chat message is not treated as a timer command', () => {
  assert.equal(parseTimeRequest('who clocked in today'), null);
  assert.equal(parseTimeRequest('what time is the client call'), null);
});

test('asking about a running timer does not create one', async () => {
  const { time, created } = source({ running: [runningHomepage] });
  const reply = await resolveTimeChat(auth({}), 'do I have a timer running?', time);
  assert.match(reply ?? '', /Homepage/);
  assert.equal(created.length, 0);
});

test('starting a timer on a named task creates an open entry', async () => {
  const { time, created } = source({ cards: [homepage] });
  const reply = await resolveTimeChat(auth({}), 'start my timer on Homepage', time);
  assert.match(reply ?? '', /started your timer on Homepage/);
  assert.equal(created.length, 1);
  assert.equal(created[0].seconds, 0);
  assert.equal(created[0].endedAt, null);
  assert.equal(created[0].userId, userId);
  assert.ok(created[0].startedAt instanceof Date);
});

test('a running timer is left alone when asked to start another', async () => {
  const { time, created } = source({ running: [runningHomepage], cards: [homepage] });
  const reply = await resolveTimeChat(
    auth({}),
    'if I do not have a timer running, go to Homepage and start my timer',
    time,
  );
  assert.match(reply ?? '', /did not start another/);
  assert.equal(created.length, 0);
});

test('two hours of manual time is a closed 7200 second entry', async () => {
  const { time, created } = source({ cards: [homepage] });
  const reply = await resolveTimeChat(auth({}), 'add 2 hours of manual time to Homepage', time);
  assert.match(reply ?? '', /2 hours/);
  assert.match(reply ?? '', /not a running timer/);
  assert.equal(created.length, 1);
  assert.equal(created[0].seconds, 7200);
  assert.ok(created[0].endedAt instanceof Date);
  assert.equal(
    created[0].endedAt!.getTime() - created[0].startedAt!.getTime(),
    7200 * 1000,
  );
});

test('start or add hours does not guess', async () => {
  const { time, created } = source({ cards: [homepage] });
  const reply = await resolveTimeChat(
    auth({}),
    'tell me if I have a time running if not go to a certain task and start my timer or add 2 hours of manual time',
    time,
  );
  assert.match(reply ?? '', /Nothing was changed/);
  assert.match(reply ?? '', /2 hours/);
  assert.equal(created.length, 0);
});

test('two matching tasks are not written', async () => {
  const { time, created } = source({
    cards: [homepage, { id: 'card-2', title: 'Homepage', boardName: 'Design' }],
  });
  const reply = await resolveTimeChat(auth({}), 'start my timer on Homepage', time);
  assert.match(reply ?? '', /More than one task/);
  assert.equal(created.length, 0);
});

test('a role without time access cannot start a timer', async () => {
  const { time, created } = source({ cards: [homepage] });
  const reply = await resolveTimeChat(
    auth({ permissions: { work: { cards: { read: true } } } }),
    'start my timer on Homepage',
    time,
  );
  assert.match(reply ?? '', /cannot see task timers/);
  assert.equal(created.length, 0);
});

test('a non-lead prompt does not include a colleague timer', async () => {
  const brief = await buildWorkspaceBrief(auth({}), {
    time: source({
      running: [
        runningHomepage,
        {
          ...runningHomepage,
          id: 'run-2',
          userId: otherId,
          userName: 'Secret Colleague',
          cardTitle: 'Private shoot',
        },
      ],
    }).time,
  });
  assert.match(brief, /Homepage/);
  assert.doesNotMatch(brief, /Secret Colleague/);
  assert.doesNotMatch(brief, /Private shoot/);
});

test('an admin prompt can include another person running timer', async () => {
  const brief = await buildWorkspaceBrief(auth({ roleKey: 'admin', isAdminRole: true }), {
    time: source({
      running: [
        runningHomepage,
        {
          ...runningHomepage,
          id: 'run-2',
          userId: otherId,
          userName: 'Secret Colleague',
          cardTitle: 'Private shoot',
        },
      ],
    }).time,
  });
  assert.match(brief, /Secret Colleague/);
  assert.match(brief, /Private shoot/);
});
