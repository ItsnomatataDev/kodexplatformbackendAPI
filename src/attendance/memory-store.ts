import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../http/errors.js';
import type {
  AttendanceDailyStatusRecord,
  AttendanceMemberRecord,
  AttendanceSessionRecord,
  AttendanceStore,
  ClockInSessionInput,
  ClockOutSessionInput,
  ListSessionsInput,
  UpsertDailyStatusInput,
} from './store.js';

function cloneSession(session: AttendanceSessionRecord): AttendanceSessionRecord {
  return {
    ...session,
    deviceInfo: { ...session.deviceInfo },
    location: { ...session.location },
  };
}

export class MemoryAttendanceStore implements AttendanceStore {
  private readonly sessions = new Map<string, AttendanceSessionRecord>();
  private readonly dailyStatus = new Map<string, AttendanceDailyStatusRecord>();
  private readonly members = new Map<
    string,
    AttendanceMemberRecord & { organizationId: string }
  >();
  private readonly memberOffice = new Map<
    string,
    { officeId: string | null; settings: Record<string, unknown> }
  >();

  seedMember(
    organizationId: string,
    member: AttendanceMemberRecord,
  ) {
    this.members.set(`${organizationId}:${member.userId}`, {
      ...member,
      organizationId,
    });
    this.memberOffice.set(`${organizationId}:${member.userId}`, {
      officeId: member.officeId,
      settings: member.officeSettings,
    });
  }

  async getActiveSession(organizationId: string, userId: string) {
    const active = [...this.sessions.values()].find(
      (session) =>
        session.organizationId === organizationId &&
        session.userId === userId &&
        session.status === 'active' &&
        session.clockOutAt == null,
    );
    return active ? cloneSession(active) : null;
  }

  async getSessionById(organizationId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.organizationId !== organizationId) return null;
    return cloneSession(session);
  }

  async listSessions(input: ListSessionsInput) {
    const limit = input.limit ?? 500;
    return [...this.sessions.values()]
      .filter((session) => {
        if (session.organizationId !== input.organizationId) return false;
        if (input.userId && session.userId !== input.userId) return false;
        if (input.officeId && session.officeId !== input.officeId) return false;
        if (input.overlap) {
          const openOrEndsInWindow =
            session.clockOutAt == null || session.clockOutAt >= input.from;
          if (session.clockInAt >= input.to || !openOrEndsInWindow) return false;
        } else if (session.clockInAt < input.from || session.clockInAt >= input.to) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.clockInAt.getTime() - a.clockInAt.getTime())
      .slice(0, limit)
      .map(cloneSession);
  }

  async clockIn(input: ClockInSessionInput) {
    const existing = await this.getActiveSession(
      input.organizationId,
      input.userId,
    );
    if (existing) {
      throw new ConflictError(
        'ATTENDANCE_ALREADY_ACTIVE',
        'You are already clocked in. Clock out before starting a new attendance session.',
      );
    }

    const now = input.clockInAt ?? new Date();
    const session: AttendanceSessionRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      officeId: input.officeId ?? null,
      userId: input.userId,
      clockInAt: now,
      clockOutAt: null,
      status: 'active',
      workSeconds: 0,
      clockInMethod: input.method ?? 'web',
      clockOutMethod: null,
      notes: input.notes ?? null,
      ipAddress: input.ipAddress ?? null,
      deviceInfo: input.deviceInfo ?? {},
      location: input.location ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return cloneSession(session);
  }

  async clockOut(input: ClockOutSessionInput) {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.organizationId !== input.organizationId) {
      throw new NotFoundError(
        'ATTENDANCE_SESSION_NOT_FOUND',
        'Active attendance session not found.',
      );
    }
    if (session.status !== 'active' || session.clockOutAt) {
      throw new ConflictError(
        'ATTENDANCE_SESSION_NOT_ACTIVE',
        'Active attendance session not found.',
      );
    }

    const clockOutAt = input.clockOutAt ?? new Date();
    session.clockOutAt = clockOutAt;
    session.clockOutMethod = input.method ?? 'web';
    session.status = 'completed';
    session.workSeconds = Math.max(0, input.workSeconds);
    if (input.notes) {
      session.notes = [session.notes, input.notes].filter(Boolean).join('\n');
    }
    session.updatedAt = clockOutAt;
    return cloneSession(session);
  }

  async upsertDailyStatus(input: UpsertDailyStatusInput) {
    const key = `${input.organizationId}:${input.userId}:${input.attendanceDate}`;
    const existing = this.dailyStatus.get(key);
    const now = new Date();
    if (existing) {
      existing.status = input.status;
      existing.officeId = input.officeId ?? existing.officeId;
      existing.expectedClockInAt =
        input.expectedClockInAt !== undefined
          ? input.expectedClockInAt
          : existing.expectedClockInAt;
      existing.actualClockInAt =
        input.actualClockInAt !== undefined
          ? input.actualClockInAt
          : existing.actualClockInAt;
      existing.sessionId =
        input.sessionId !== undefined ? input.sessionId : existing.sessionId;
      existing.updatedAt = now;
      return { ...existing };
    }

    const record: AttendanceDailyStatusRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      officeId: input.officeId ?? null,
      userId: input.userId,
      attendanceDate: input.attendanceDate,
      status: input.status,
      expectedClockInAt: input.expectedClockInAt ?? null,
      actualClockInAt: input.actualClockInAt ?? null,
      sessionId: input.sessionId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.dailyStatus.set(key, record);
    return { ...record };
  }

  async listDailyStatus(input: {
    organizationId: string;
    attendanceDate: string;
    userId?: string | null;
    officeId?: string | null;
  }) {
    return [...this.dailyStatus.values()].filter((row) => {
      if (row.organizationId !== input.organizationId) return false;
      if (row.attendanceDate !== input.attendanceDate) return false;
      if (input.userId && row.userId !== input.userId) return false;
      if (input.officeId && row.officeId !== input.officeId) return false;
      return true;
    });
  }

  async listMembers(organizationId: string) {
    return [...this.members.values()]
      .filter((member) => member.organizationId === organizationId)
      .map(({ organizationId: _org, ...member }) => member);
  }

  async getMemberOfficeSettings(organizationId: string, userId: string) {
    return (
      this.memberOffice.get(`${organizationId}:${userId}`) ?? null
    );
  }

  async getOrganizationSettings(_organizationId: string) {
    return {};
  }
}
