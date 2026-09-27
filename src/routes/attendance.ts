import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import {
  readJson,
  readOptionalString,
  requireUuidValue,
} from '../work/http.js';
import type { AuthContext } from '../authorization/types.js';
import { assertWithinOfficeGeofences } from '../attendance/geofence.js';
import {
  harareTimeToday,
  parseAttendanceSchedule,
} from '../attendance/harare.js';
import type {
  AttendanceSessionRecord,
  AttendanceStore,
} from '../attendance/store.js';

export type AttendanceRouteDependencies = {
  store: AttendanceStore;
};

function serializeSession(session: AttendanceSessionRecord) {
  return {
    id: session.id,
    organizationId: session.organizationId,
    officeId: session.officeId,
    userId: session.userId,
    clockInAt: session.clockInAt.toISOString(),
    clockOutAt: session.clockOutAt?.toISOString() ?? null,
    status: session.status,
    workSeconds: session.workSeconds,
    clockInMethod: session.clockInMethod,
    clockOutMethod: session.clockOutMethod,
    notes: session.notes,
    ipAddress: session.ipAddress,
    deviceInfo: session.deviceInfo,
    location: session.location,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    userName: session.userName ?? null,
    userEmail: session.userEmail ?? null,
  };
}

function authorizeAttendance(auth: ReturnType<typeof getAuth>, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: {
      type: 'attendance',
      organizationId,
    },
  });
  return organizationId;
}

function isAttendanceStaff(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'attendance.manage')
  );
}

function isPresenceOnlyOffice(settings: Record<string, unknown> | null | undefined) {
  if (!settings || typeof settings !== 'object') return false;
  return settings.attendance_mode === 'presence_only';
}

function zimbabweDateKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function zimbabweDayRange(dateKey: string) {
  const start = new Date(`${dateKey}T00:00:00+02:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end, dateKey };
}

function parseIsoDate(value: string | undefined, field: string) {
  if (!value) {
    throw new ValidationError(`${field} is required.`, { field });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field} must be a valid ISO timestamp.`, {
      field,
    });
  }
  return date;
}

function secondsBetween(start: Date, end: Date) {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
}

function readOptionalObject(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object.`, { field });
  }
  return value as Record<string, unknown>;
}

function sessionElapsedSeconds(session: AttendanceSessionRecord, now = new Date()) {
  if (session.clockOutAt) {
    return Math.max(0, session.workSeconds);
  }
  return secondsBetween(session.clockInAt, now);
}

export function createAttendanceRoutes(dependencies: AttendanceRouteDependencies) {
  const routes = new Hono();

  routes.get('/today', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeAttendance(auth, 'attendance.read');
    const userId = auth.actor.userId;
    const { start, end } = zimbabweDayRange(zimbabweDateKey());

    const [sessions, activeSession, office] = await Promise.all([
      dependencies.store.listSessions({
        organizationId,
        userId,
        from: start,
        to: end,
      }),
      dependencies.store.getActiveSession(organizationId, userId),
      dependencies.store.getMemberOfficeSettings(organizationId, userId),
    ]);

    const presenceOnly = isPresenceOnlyOffice(office?.settings);
    const workedSeconds = presenceOnly
      ? 0
      : sessions.reduce(
          (sum, session) => sum + sessionElapsedSeconds(session),
          0,
        );

    return c.json({
      activeSession: activeSession ? serializeSession(activeSession) : null,
      sessions: sessions.map(serializeSession),
      workedSeconds,
      presenceOnly,
      officeId: office?.officeId ?? null,
    });
  });

  routes.get('/active', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeAttendance(auth, 'attendance.read');
    const activeSession = await dependencies.store.getActiveSession(
      organizationId,
      auth.actor.userId,
    );
    return c.json({
      session: activeSession ? serializeSession(activeSession) : null,
    });
  });

  routes.post('/clock-in', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeAttendance(auth, 'attendance.clock');
    const body = await readJson(c);
    rejectClientIdentity(body);

    const office = await dependencies.store.getMemberOfficeSettings(
      organizationId,
      auth.actor.userId,
    );
    const location =
      readOptionalObject(body.location, 'location') ?? undefined;
    try {
      assertWithinOfficeGeofences({
        settings: office?.settings ?? null,
        location: location ?? null,
      });
    } catch (error) {
      throw new ValidationError(
        error instanceof Error
          ? error.message
          : 'You are outside the allowed clock-in area.',
        { field: 'location' },
      );
    }
    const session = await dependencies.store.clockIn({
      organizationId,
      userId: auth.actor.userId,
      officeId: office?.officeId ?? auth.membership.officeId ?? null,
      method: readOptionalString(body.method, 'method') ?? 'web',
      notes: readOptionalString(body.notes, 'notes'),
      ipAddress: c.get('clientIp') ?? null,
      deviceInfo: readOptionalObject(body.deviceInfo ?? body.device_info, 'deviceInfo'),
      location,
    });

    const dateKey = zimbabweDateKey(session.clockInAt);
    const orgSettings =
      await dependencies.store.getOrganizationSettings(organizationId);
    const schedule = parseAttendanceSchedule(orgSettings);
    const lateAfter = harareTimeToday(schedule.lateAfter, dateKey);
    const isLate = session.clockInAt.getTime() > lateAfter.getTime();

    await dependencies.store.upsertDailyStatus({
      organizationId,
      userId: auth.actor.userId,
      officeId: session.officeId,
      attendanceDate: dateKey,
      status: isLate ? 'late' : 'present',
      expectedClockInAt: harareTimeToday(schedule.workdayStart, dateKey),
      actualClockInAt: session.clockInAt,
      sessionId: session.id,
    });

    return c.json({ session: serializeSession(session) }, 201);
  });

  routes.post('/sessions/:sessionId/clock-out', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeAttendance(auth, 'attendance.clock');
    const sessionId = requireUuidValue(c.req.param('sessionId'), 'sessionId');
    const body = await readJson(c);
    rejectClientIdentity(body);

    const existing = await dependencies.store.getSessionById(
      organizationId,
      sessionId,
    );
    if (!existing) {
      throw new ValidationError('Active attendance session not found.', {
        field: 'sessionId',
      });
    }

    const method = readOptionalString(body.method, 'method') ?? 'web';
    const isAdminClockOut = method === 'admin';
    if (existing.userId !== auth.actor.userId) {
      if (!isAdminClockOut || !isAttendanceStaff(auth)) {
        throw new ForbiddenError(
          'ATTENDANCE_CLOCK_OUT_FORBIDDEN',
          'You can only clock out your own attendance session.',
        );
      }
      authorizeAttendance(auth, 'attendance.manage');
    }

    const office = await dependencies.store.getMemberOfficeSettings(
      organizationId,
      existing.userId,
    );
    const presenceOnly = isPresenceOnlyOffice(office?.settings);
    const clockOutAt = new Date();
    const workSeconds = presenceOnly
      ? 0
      : secondsBetween(existing.clockInAt, clockOutAt);

    const session = await dependencies.store.clockOut({
      sessionId,
      organizationId,
      method,
      notes: readOptionalString(body.notes, 'notes'),
      clockOutAt,
      workSeconds,
    });

    return c.json({ session: serializeSession(session) });
  });

  routes.get('/sessions', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeAttendance(auth, 'attendance.read');
    const from = parseIsoDate(c.req.query('from') ?? undefined, 'from');
    const to = parseIsoDate(c.req.query('to') ?? undefined, 'to');
    const requestedUserId = c.req.query('userId') ?? c.req.query('user_id');
    const officeId = c.req.query('officeId') ?? c.req.query('office_id');

    let userId: string | null = auth.actor.userId;
    if (requestedUserId) {
      const parsed = requireUuidValue(requestedUserId, 'userId');
      if (parsed !== auth.actor.userId && !isAttendanceStaff(auth)) {
        throw new ForbiddenError(
          'ATTENDANCE_LIST_FORBIDDEN',
          'Only attendance managers can list other users’ sessions.',
        );
      }
      userId = parsed;
    } else if (isAttendanceStaff(auth) && (c.req.query('scope') === 'organization' || officeId)) {
      userId = null;
    }

    const sessions = await dependencies.store.listSessions({
      organizationId,
      userId,
      officeId: officeId ? requireUuidValue(officeId, 'officeId') : null,
      from,
      to,
    });

    return c.json({ sessions: sessions.map(serializeSession) });
  });

  routes.get('/report', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeAttendance(auth, 'attendance.read');
    if (!isAttendanceStaff(auth)) {
      throw new ForbiddenError(
        'ATTENDANCE_REPORT_FORBIDDEN',
        'Only attendance managers can view the team attendance report.',
      );
    }
    authorizeAttendance(auth, 'attendance.manage');

    const from = parseIsoDate(c.req.query('from') ?? undefined, 'from');
    const to = parseIsoDate(c.req.query('to') ?? undefined, 'to');
    const officeIdRaw = c.req.query('officeId') ?? c.req.query('office_id');
    const officeId = officeIdRaw
      ? requireUuidValue(officeIdRaw, 'officeId')
      : null;
    const dateKey = zimbabweDateKey(from);

    const [members, sessions, dailyStatus] = await Promise.all([
      dependencies.store.listMembers(organizationId),
      // Do not filter sessions by office. A clock-in must stay on the
      // person's row even when the session office differs from the filter.
      dependencies.store.listSessions({
        organizationId,
        from,
        to,
        limit: 5000,
        overlap: true,
      }),
      dependencies.store.listDailyStatus({
        organizationId,
        attendanceDate: dateKey,
      }),
    ]);

    const sessionsByUser = new Map<string, AttendanceSessionRecord[]>();
    for (const session of sessions) {
      const list = sessionsByUser.get(session.userId) ?? [];
      list.push(session);
      sessionsByUser.set(session.userId, list);
    }
    for (const [userId, list] of sessionsByUser) {
      list.sort((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime());
      sessionsByUser.set(userId, list);
    }
    const dailyByUser = new Map(
      dailyStatus.map((row) => [row.userId, row] as const),
    );

    const rows = members
      .filter((member) => !officeId || member.officeId === officeId)
      .map((member) => {
        const userSessions = sessionsByUser.get(member.userId) ?? [];
        const first = userSessions[0] ?? null;
        const last = userSessions[userSessions.length - 1] ?? null;
        const presenceOnly = isPresenceOnlyOffice(member.officeSettings);
        const activeSession = userSessions.find(
          (session) => session.status === 'active' && !session.clockOutAt,
        );
        const workSeconds = presenceOnly
          ? 0
          : userSessions.reduce(
              (sum, session) => sum + sessionElapsedSeconds(session),
              0,
            );
        const daily = dailyByUser.get(member.userId);

        return {
          userId: member.userId,
          fullName: member.fullName,
          email: member.email,
          officeId: member.officeId,
          presenceOnly,
          dailyStatus: daily?.status ?? null,
          activeSessionId: activeSession?.id ?? null,
          clockInAt: first?.clockInAt.toISOString() ?? null,
          clockOutAt: last?.clockOutAt?.toISOString() ?? null,
          workSeconds,
          status: activeSession
            ? 'active'
            : last?.status ?? 'offline',
          isLate: daily?.status === 'late',
          missedClockOut: userSessions.some(
            (session) => session.status === 'missed_clock_out',
          ),
          clockOutMethod: last?.clockOutMethod ?? null,
        };
      });

    return c.json({ rows, from: from.toISOString(), to: to.toISOString() });
  });

  return routes;
}

function rejectClientIdentity(body: Record<string, unknown>) {
  for (const field of [
    'userId',
    'user_id',
    'organizationId',
    'organization_id',
    'actorUserId',
    'actor_user_id',
  ]) {
    if (body[field] !== undefined) {
      throw new ValidationError(
        `${field} cannot be set by the client.`,
        { field },
      );
    }
  }
}
