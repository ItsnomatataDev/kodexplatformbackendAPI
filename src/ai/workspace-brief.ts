import type { AuthContext } from '../authorization/types.js';
import { harareDateKey, harareDayRange } from '../attendance/harare.js';
import type { NavigationSource } from './navigation.js';
import { timerFacts, type TimeActionSource } from './time-actions.js';
import { describeWorkspaceAccess, workspaceAccess } from './role-access.js';

const MAX_BRIEF_CHARS = 4_500;
const MAX_ROWS = 25;

export type AttendanceSnapshotSource = {
  listMembers(organizationId: string): Promise<Array<{
    userId: string;
    fullName: string | null;
    email: string | null;
    roleKey: string | null;
  }>>;
  listSessions(input: {
    organizationId: string;
    userId: string | null;
    from: Date;
    to: Date;
  }): Promise<Array<{
    userId: string;
    userName?: string | null;
    userEmail?: string | null;
    clockInAt: Date;
    clockOutAt: Date | null;
    status: string;
  }>>;
};

export type TicketSnapshotSource = {
  list(input: {
    organizationId: string;
    requesterUserId?: string | null;
    limit?: number;
  }): Promise<Array<{
    subject: string;
    status: string;
    userId?: string | null;
  }>>;
};

export type LeaveSnapshotSource = {
  listMyRequests(
    organizationId: string,
    userId: string,
    page?: { limit?: number },
  ): Promise<{ requests: Array<{ status: string; startDate: string; endDate: string; reason: string | null }> }>;
  listRequests(
    organizationId: string,
    officeId?: string | null,
    page?: { limit?: number },
  ): Promise<{ requests: Array<{ status: string; startDate: string; endDate: string; userId: string; reason: string | null }> }>;
};

export type WorkspaceSources = {
  attendance?: AttendanceSnapshotSource;
  tickets?: TicketSnapshotSource;
  leave?: LeaveSnapshotSource;
  time?: TimeActionSource;
  navigation?: NavigationSource;
};

function personName(name: string | null | undefined, email: string | null | undefined, userId: string) {
  return name?.trim() || email?.trim() || userId;
}

function clockLine(session: {
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  status: string;
}) {
  const who = personName(session.userName, session.userEmail, session.userId);
  const inn = session.clockInAt.toISOString();
  const out = session.clockOutAt ? session.clockOutAt.toISOString() : 'still in';
  return `- ${who}: in ${inn}, out ${out}, ${session.status}`;
}

async function attendanceFacts(auth: AuthContext, source: AttendanceSnapshotSource) {
  const access = workspaceAccess(auth);
  const { start, end, dateKey } = harareDayRange(harareDateKey());
  if (access.areas.includes('attendance_team')) {
    const [members, sessions] = await Promise.all([
      source.listMembers(auth.membership.organizationId),
      source.listSessions({
        organizationId: auth.membership.organizationId,
        userId: null,
        from: start,
        to: end,
      }),
    ]);
    const names = new Map(members.map((member) => [member.userId, personName(member.fullName, member.email, member.userId)]));
    const seen = new Set(sessions.map((session) => session.userId));
    const present = sessions.slice(0, MAX_ROWS).map((session) => clockLine({
      ...session,
      userName: session.userName ?? names.get(session.userId) ?? null,
    }));
    const absent = members
      .filter((member) => !seen.has(member.userId))
      .slice(0, MAX_ROWS)
      .map((member) => `- ${personName(member.fullName, member.email, member.userId)} (${member.roleKey ?? 'staff'})`);
    return [
      `Attendance today (${dateKey}), organization view:`,
      present.length ? present.join('\n') : '- Nobody has clocked in.',
      'Not clocked in:',
      absent.length ? absent.join('\n') : '- Everyone listed has a session.',
    ].join('\n');
  }
  if (!access.areas.includes('attendance_own')) {
    return 'Attendance: hidden for this role.';
  }
  const sessions = (await source.listSessions({
    organizationId: auth.membership.organizationId,
    userId: auth.actor.userId,
    from: start,
    to: end,
  })).filter((session) => session.userId === auth.actor.userId);
  const lines = sessions.slice(0, 5).map((session) => clockLine({
    ...session,
    userName: 'You',
    userEmail: null,
  }));
  return [
    `Attendance today (${dateKey}), your sessions only:`,
    lines.length ? lines.join('\n') : '- You have not clocked in.',
  ].join('\n');
}

async function ticketFacts(auth: AuthContext, source: TicketSnapshotSource) {
  const access = workspaceAccess(auth);
  if (!access.areas.includes('tickets_own') && !access.areas.includes('tickets_team')) {
    return 'Tickets: hidden for this role.';
  }
  const team = access.areas.includes('tickets_team');
  const tickets = await source.list({
    organizationId: auth.membership.organizationId,
    requesterUserId: team ? null : auth.actor.userId,
    limit: MAX_ROWS,
  });
  const lines = tickets.slice(0, MAX_ROWS).map((ticket) => `- ${ticket.status}: ${ticket.subject}`);
  return [
    team ? 'Recent organization tickets:' : 'Your recent tickets:',
    lines.length ? lines.join('\n') : '- None.',
  ].join('\n');
}

async function leaveFacts(auth: AuthContext, source: LeaveSnapshotSource) {
  const access = workspaceAccess(auth);
  if (access.areas.includes('leave_team')) {
    const page = await source.listRequests(auth.membership.organizationId, null, { limit: MAX_ROWS });
    const lines = page.requests.slice(0, MAX_ROWS).map(
      (request) => `- ${request.status} ${request.startDate} to ${request.endDate} user ${request.userId}`,
    );
    return ['Leave requests you can manage:', lines.length ? lines.join('\n') : '- None.'].join('\n');
  }
  if (!access.areas.includes('leave_own')) {
    return 'Leave: hidden for this role.';
  }
  const page = await source.listMyRequests(auth.membership.organizationId, auth.actor.userId, {
    limit: 8,
  });
  const lines = page.requests.slice(0, 8).map(
    (request) => `- ${request.status} ${request.startDate} to ${request.endDate}`,
  );
  return ['Your leave requests:', lines.length ? lines.join('\n') : '- None.'].join('\n');
}

async function safeSection(label: string, load: () => Promise<string>) {
  try {
    return await load();
  } catch {
    return `${label}: unavailable right now.`;
  }
}

export async function buildWorkspaceBrief(auth: AuthContext, sources: WorkspaceSources = {}) {
  const described = describeWorkspaceAccess(auth);
  const sections = [
    'This is one ongoing chat. Earlier user and assistant messages in this request are the same conversation, including after the user closes the app and comes back. Remember what they asked and what you answered. Words like "that", "it", and "the last thing" refer to this chat.',
    'Workspace facts below limit which organization records you may reveal. Use only these facts for staff, clock-ins, tickets, leave, and task timers. If one of those records is not listed, say this role cannot see it. Do not invent those records. Do not forget the conversation in order to follow that limit.',
    `Role: ${described.roleKey}${described.admin ? ' (admin, full workspace access)' : ''}.`,
    `Can see: ${described.allowedLabels.join('; ') || 'general chat only'}.`,
    described.denied.length ? `Cannot see: ${described.denied.join('; ')}.` : '',
  ];
  if (sources.time) {
    sections.push(await safeSection('Task timers', () => timerFacts(auth, sources.time!)));
  }
  if (sources.attendance) {
    sections.push(await safeSection('Attendance', () => attendanceFacts(auth, sources.attendance!)));
  }
  if (sources.leave) {
    sections.push(await safeSection('Leave', () => leaveFacts(auth, sources.leave!)));
  }
  if (sources.tickets) {
    sections.push(await safeSection('Tickets', () => ticketFacts(auth, sources.tickets!)));
  }
  sections.push(
    'Payslips, stored employee files, and security events are not preloaded. When a user message includes attached document text, summarize and answer from that text. If they ask to summarize a document and no document text is attached, ask them to attach a text-based PDF, Word document, CSV, or plain text file. Do not invent document contents.',
  );
  const text = sections.filter(Boolean).join('\n');
  if (text.length <= MAX_BRIEF_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_BRIEF_CHARS)}\n…truncated`;
}
