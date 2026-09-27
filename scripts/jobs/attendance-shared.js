import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/pool.js';
import { PostgresNotificationStore } from '../../src/notifications/postgres-store.js';
import { NOTIFICATION_TYPES } from '../../src/notifications/store.js';
import { sendAttendanceEmail } from '../../src/email/attendance-mailer.js';
import { harareDateKey, harareDayRange, isHarareWeekday, isPresenceOnlySettings, parseAttendanceSchedule, secondsBetween, } from '../../src/attendance/harare.js';
import { logger } from '../../src/config/logger.js';
export const notifications = new PostgresNotificationStore();
export async function listOrganizations() {
    const result = await db.query(`
      SELECT id, name, settings
      FROM organizations.organizations
      WHERE is_active = TRUE
        AND status = 'active'
    `);
    return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        settings: row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
            ? row.settings
            : {},
    }));
}
export function scheduleForOrg(org) {
    return parseAttendanceSchedule(org.settings);
}
export async function listActiveMembers(organizationId) {
    const result = await db.query(`
      SELECT
        m.user_id,
        u.email,
        p.full_name,
        m.office_id,
        ofc.settings AS office_settings
      FROM organizations.memberships m
      JOIN identity.users u ON u.id = m.user_id
      LEFT JOIN identity.user_profiles p ON p.user_id = m.user_id
      LEFT JOIN organizations.offices ofc ON ofc.id = m.office_id
      WHERE m.organization_id = $1
        AND m.status = 'active'
        AND u.is_active = TRUE
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
    `, [organizationId]);
    return result.rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        fullName: row.full_name,
        officeId: row.office_id,
        officeSettings: row.office_settings &&
            typeof row.office_settings === 'object' &&
            !Array.isArray(row.office_settings)
            ? row.office_settings
            : {},
    }));
}
export async function listClockedInUserIds(params) {
    const result = await db.query(`
      SELECT DISTINCT user_id
      FROM attendance.sessions
      WHERE organization_id = $1
        AND clock_in_at >= $2
        AND clock_in_at < $3
    `, [params.organizationId, params.from, params.to]);
    return new Set(result.rows.map((row) => row.user_id));
}
export async function listActiveSessions() {
    const result = await db.query(`
      SELECT
        s.id,
        s.organization_id,
        s.user_id,
        s.office_id,
        s.clock_in_at,
        s.notes,
        ofc.settings AS office_settings
      FROM attendance.sessions s
      LEFT JOIN organizations.offices ofc ON ofc.id = s.office_id
      WHERE s.status = 'active'
        AND s.clock_out_at IS NULL
    `);
    return result.rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        userId: row.user_id,
        officeId: row.office_id,
        clockInAt: row.clock_in_at,
        notes: row.notes,
        officeSettings: row.office_settings &&
            typeof row.office_settings === 'object' &&
            !Array.isArray(row.office_settings)
            ? row.office_settings
            : {},
    }));
}
export async function autoClockOutSession(session, clockOutAt) {
    const presenceOnly = isPresenceOnlySettings(session.officeSettings);
    const workSeconds = presenceOnly
        ? 0
        : secondsBetween(session.clockInAt, clockOutAt);
    const marker = `Auto clocked out by system at ${clockOutAt.toISOString()} (18:00 Africa/Harare).`;
    const notes = session.notes?.includes('Auto clocked out by system')
        ? session.notes
        : [session.notes, marker].filter(Boolean).join('\n');
    await db.query(`
      UPDATE attendance.sessions
      SET
        clock_out_at = $2,
        clock_out_method = 'auto',
        status = 'completed',
        work_seconds = $3,
        notes = $4,
        updated_at = NOW()
      WHERE id = $1
        AND status = 'active'
        AND clock_out_at IS NULL
    `, [session.id, clockOutAt, workSeconds, notes]);
}
export async function upsertDailyStatus(params) {
    await db.query(`
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
    `, [
        params.organizationId,
        params.officeId,
        params.userId,
        params.attendanceDate,
        params.status,
        params.expectedClockInAt ?? null,
        params.actualClockInAt ?? null,
        params.sessionId ?? null,
    ]);
}
export async function notifyAttendance(params) {
    return notifications.create({
        organizationId: params.organizationId,
        recipientUserId: params.recipientUserId,
        type: params.type,
        title: params.title,
        message: params.message,
        entityType: 'attendance',
        entityId: params.entityId,
        actionUrl: params.actionUrl ?? '/attendance',
        priority: params.type === NOTIFICATION_TYPES.attendanceLate ? 'high' : 'medium',
        category: 'attendance',
        dedupeKey: params.dedupeKey,
        metadata: params.metadata ?? {},
    });
}
export async function emailIfPossible(params) {
    if (!params.to)
        return false;
    return sendAttendanceEmail({
        to: params.to,
        subject: params.subject,
        text: params.text,
    });
}
export function shouldRunWeekdayJob(schedule, now = new Date()) {
    if (!schedule.weekdaysOnly)
        return true;
    return isHarareWeekday(now);
}
export function todayRange(now = new Date()) {
    return harareDayRange(harareDateKey(now));
}
export function newEntityId() {
    return randomUUID();
}
export { harareDateKey, logger, NOTIFICATION_TYPES };
//# sourceMappingURL=attendance-shared.js.map