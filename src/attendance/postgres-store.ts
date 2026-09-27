import { db } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import type {
  AttendanceDailyStatusRecord,
  AttendanceDailyStatusValue,
  AttendanceMemberRecord,
  AttendanceSessionRecord,
  AttendanceSessionStatus,
  AttendanceStore,
  ClockInSessionInput,
  ClockOutSessionInput,
  ListSessionsInput,
  UpsertDailyStatusInput,
} from './store.js';

type SessionRow = {
  id: string;
  organization_id: string;
  office_id: string | null;
  user_id: string;
  clock_in_at: Date;
  clock_out_at: Date | null;
  status: AttendanceSessionStatus;
  work_seconds: number;
  clock_in_method: string;
  clock_out_method: string | null;
  notes: string | null;
  ip_address: string | null;
  device_info: Record<string, unknown> | null;
  location: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  user_name?: string | null;
  user_email?: string | null;
};

type DailyStatusRow = {
  id: string;
  organization_id: string;
  office_id: string | null;
  user_id: string;
  attendance_date: string;
  status: AttendanceDailyStatusValue;
  expected_clock_in_at: Date | null;
  actual_clock_in_at: Date | null;
  session_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type MemberRow = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  office_id: string | null;
  office_slug: string | null;
  office_settings: Record<string, unknown> | null;
  role_key: string | null;
};

const SESSION_COLUMNS = `
  s.id,
  s.organization_id,
  s.office_id,
  s.user_id,
  s.clock_in_at,
  s.clock_out_at,
  s.status,
  s.work_seconds,
  s.clock_in_method,
  s.clock_out_method,
  s.notes,
  s.ip_address,
  s.device_info,
  s.location,
  s.created_at,
  s.updated_at
`;

const SESSION_RETURNING = `
  id,
  organization_id,
  office_id,
  user_id,
  clock_in_at,
  clock_out_at,
  status,
  work_seconds,
  clock_in_method,
  clock_out_method,
  notes,
  ip_address,
  device_info,
  location,
  created_at,
  updated_at
`;

function asObject(value: Record<string, unknown> | null | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function serializeSession(row: SessionRow): AttendanceSessionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    userId: row.user_id,
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
    status: row.status,
    workSeconds: Number(row.work_seconds ?? 0),
    clockInMethod: row.clock_in_method,
    clockOutMethod: row.clock_out_method,
    notes: row.notes,
    ipAddress: row.ip_address,
    deviceInfo: asObject(row.device_info),
    location: asObject(row.location),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userName: row.user_name ?? null,
    userEmail: row.user_email ?? null,
  };
}

function serializeDailyStatus(row: DailyStatusRow): AttendanceDailyStatusRecord {
  const dateValue =
    typeof row.attendance_date === 'string'
      ? row.attendance_date.slice(0, 10)
      : new Date(row.attendance_date).toISOString().slice(0, 10);
  return {
    id: row.id,
    organizationId: row.organization_id,
    officeId: row.office_id,
    userId: row.user_id,
    attendanceDate: dateValue,
    status: row.status,
    expectedClockInAt: row.expected_clock_in_at,
    actualClockInAt: row.actual_clock_in_at,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresAttendanceStore implements AttendanceStore {
  async getActiveSession(organizationId: string, userId: string) {
    const result = await db.query<SessionRow>(
      `
        SELECT ${SESSION_COLUMNS}
        FROM attendance.sessions s
        WHERE s.organization_id = $1
          AND s.user_id = $2
          AND s.status = 'active'
          AND s.clock_out_at IS NULL
        ORDER BY s.clock_in_at DESC
        LIMIT 1
      `,
      [organizationId, userId],
    );
    return result.rows[0] ? serializeSession(result.rows[0]) : null;
  }

  async getSessionById(organizationId: string, sessionId: string) {
    const result = await db.query<SessionRow>(
      `
        SELECT ${SESSION_COLUMNS}
        FROM attendance.sessions s
        WHERE s.organization_id = $1
          AND s.id = $2
        LIMIT 1
      `,
      [organizationId, sessionId],
    );
    return result.rows[0] ? serializeSession(result.rows[0]) : null;
  }

  async listSessions(input: ListSessionsInput) {
    const limit = input.limit ?? 500;
    const result = await db.query<SessionRow>(
      `
        SELECT
          ${SESSION_COLUMNS},
          p.full_name AS user_name,
          u.email AS user_email
        FROM attendance.sessions s
        LEFT JOIN identity.users u ON u.id = s.user_id
        LEFT JOIN identity.user_profiles p ON p.user_id = s.user_id
        WHERE s.organization_id = $1
          AND (
            (
              COALESCE($7::boolean, FALSE) = FALSE
              AND s.clock_in_at >= $2
              AND s.clock_in_at < $3
            )
            OR (
              COALESCE($7::boolean, FALSE) = TRUE
              AND s.clock_in_at < $3
              AND (s.clock_out_at IS NULL OR s.clock_out_at >= $2)
            )
          )
          AND ($4::uuid IS NULL OR s.user_id = $4)
          AND ($5::uuid IS NULL OR s.office_id = $5)
        ORDER BY s.clock_in_at DESC
        LIMIT $6
      `,
      [
        input.organizationId,
        input.from,
        input.to,
        input.userId ?? null,
        input.officeId ?? null,
        limit,
        input.overlap === true,
      ],
    );
    return result.rows.map(serializeSession);
  }

  async clockIn(input: ClockInSessionInput) {
    const clockInAt = input.clockInAt ?? new Date();
    try {
      const result = await db.query<SessionRow>(
        `
          INSERT INTO attendance.sessions (
            organization_id,
            office_id,
            user_id,
            clock_in_at,
            status,
            clock_in_method,
            notes,
            ip_address,
            device_info,
            location
          )
          VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8::jsonb, $9::jsonb)
          RETURNING ${SESSION_RETURNING}
        `,
        [
          input.organizationId,
          input.officeId ?? null,
          input.userId,
          clockInAt,
          input.method ?? 'web',
          input.notes ?? null,
          input.ipAddress ?? null,
          JSON.stringify(input.deviceInfo ?? {}),
          JSON.stringify(input.location ?? {}),
        ],
      );
      return serializeSession(result.rows[0]!);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (code === '23505') {
        throw new ConflictError(
          'ATTENDANCE_ALREADY_ACTIVE',
          'You are already clocked in. Clock out before starting a new attendance session.',
        );
      }
      throw error;
    }
  }

  async clockOut(input: ClockOutSessionInput) {
    const clockOutAt = input.clockOutAt ?? new Date();
    const result = await db.query<SessionRow>(
      `
        UPDATE attendance.sessions
        SET
          clock_out_at = $3,
          clock_out_method = $4,
          status = 'completed',
          work_seconds = $5,
          notes = CASE
            WHEN $6::text IS NULL OR length(trim($6::text)) = 0 THEN notes
            WHEN notes IS NULL OR length(trim(notes)) = 0 THEN $6
            ELSE notes || E'\\n' || $6
          END,
          updated_at = NOW()
        WHERE id = $1
          AND organization_id = $2
          AND status = 'active'
          AND clock_out_at IS NULL
        RETURNING ${SESSION_RETURNING}
      `,
      [
        input.sessionId,
        input.organizationId,
        clockOutAt,
        input.method ?? 'web',
        Math.max(0, input.workSeconds),
        input.notes ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError(
        'ATTENDANCE_SESSION_NOT_FOUND',
        'Active attendance session not found.',
      );
    }
    return serializeSession(result.rows[0]);
  }

  async upsertDailyStatus(input: UpsertDailyStatusInput) {
    const result = await db.query<DailyStatusRow>(
      `
        INSERT INTO attendance.daily_status (
          organization_id,
          office_id,
          user_id,
          attendance_date,
          status,
          expected_clock_in_at,
          actual_clock_in_at,
          session_id
        )
        VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)
        ON CONFLICT (organization_id, user_id, attendance_date)
        DO UPDATE SET
          office_id = COALESCE(EXCLUDED.office_id, attendance.daily_status.office_id),
          status = EXCLUDED.status,
          expected_clock_in_at = COALESCE(
            EXCLUDED.expected_clock_in_at,
            attendance.daily_status.expected_clock_in_at
          ),
          actual_clock_in_at = COALESCE(
            EXCLUDED.actual_clock_in_at,
            attendance.daily_status.actual_clock_in_at
          ),
          session_id = COALESCE(EXCLUDED.session_id, attendance.daily_status.session_id),
          updated_at = NOW()
        RETURNING
          id,
          organization_id,
          office_id,
          user_id,
          attendance_date::text AS attendance_date,
          status,
          expected_clock_in_at,
          actual_clock_in_at,
          session_id,
          created_at,
          updated_at
      `,
      [
        input.organizationId,
        input.officeId ?? null,
        input.userId,
        input.attendanceDate,
        input.status,
        input.expectedClockInAt ?? null,
        input.actualClockInAt ?? null,
        input.sessionId ?? null,
      ],
    );
    return serializeDailyStatus(result.rows[0]!);
  }

  async listDailyStatus(input: {
    organizationId: string;
    attendanceDate: string;
    userId?: string | null;
    officeId?: string | null;
  }) {
    const result = await db.query<DailyStatusRow>(
      `
        SELECT
          id,
          organization_id,
          office_id,
          user_id,
          attendance_date::text AS attendance_date,
          status,
          expected_clock_in_at,
          actual_clock_in_at,
          session_id,
          created_at,
          updated_at
        FROM attendance.daily_status
        WHERE organization_id = $1
          AND attendance_date = $2::date
          AND ($3::uuid IS NULL OR user_id = $3)
          AND ($4::uuid IS NULL OR office_id = $4)
      `,
      [
        input.organizationId,
        input.attendanceDate,
        input.userId ?? null,
        input.officeId ?? null,
      ],
    );
    return result.rows.map(serializeDailyStatus);
  }

  async listMembers(organizationId: string): Promise<AttendanceMemberRecord[]> {
    const result = await db.query<MemberRow>(
      `
        SELECT
          m.user_id,
          p.full_name,
          u.email,
          m.office_id,
          ofc.slug AS office_slug,
          ofc.settings AS office_settings,
          m.role_key
        FROM organizations.memberships m
        LEFT JOIN identity.users u ON u.id = m.user_id
        LEFT JOIN identity.user_profiles p ON p.user_id = m.user_id
        LEFT JOIN organizations.offices ofc ON ofc.id = m.office_id
        WHERE m.organization_id = $1
          AND m.status = 'active'
        ORDER BY p.full_name NULLS LAST, m.user_id
      `,
      [organizationId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      fullName: row.full_name,
      email: row.email,
      officeId: row.office_id,
      officeSlug: row.office_slug,
      officeSettings: asObject(row.office_settings),
      roleKey: row.role_key,
    }));
  }

  async getMemberOfficeSettings(organizationId: string, userId: string) {
    const result = await db.query<{
      office_id: string | null;
      settings: Record<string, unknown> | null;
    }>(
      `
        SELECT m.office_id, ofc.settings
        FROM organizations.memberships m
        LEFT JOIN organizations.offices ofc ON ofc.id = m.office_id
        WHERE m.organization_id = $1
          AND m.user_id = $2
          AND m.status = 'active'
        LIMIT 1
      `,
      [organizationId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      officeId: row.office_id,
      settings: asObject(row.settings),
    };
  }

  async getOrganizationSettings(organizationId: string) {
    const result = await db.query<{
      settings: Record<string, unknown> | null;
    }>(
      `
        SELECT settings
        FROM organizations.organizations
        WHERE id = $1
        LIMIT 1
      `,
      [organizationId],
    );
    return asObject(result.rows[0]?.settings ?? null);
  }
}
