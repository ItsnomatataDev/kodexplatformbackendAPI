import { db } from '../db/pool.js';
import { endOfDaySql } from './end-of-day.js';

/** Catch overdue sessions on API reads/writes as well as in the scheduler. */
export async function closeDueAttendanceSessions(
  organizationId: string, userId?: string | null, now = new Date(),
) {
  const result = await db.query(
    `WITH due AS (
       SELECT s.id, s.clock_in_at, ${endOfDaySql('s.clock_in_at')} AS cutoff,
              COALESCE(ofc.settings->>'attendance_mode', '') = 'presence_only' AS presence_only
       FROM attendance.sessions s
       LEFT JOIN organizations.offices ofc ON ofc.id = s.office_id
       WHERE s.organization_id = $1 AND ($2::uuid IS NULL OR s.user_id = $2)
         AND s.status = 'active' AND s.clock_out_at IS NULL
         AND ${endOfDaySql('s.clock_in_at')} <= $3::timestamptz
     )
     UPDATE attendance.sessions s
     SET clock_out_at = due.cutoff, clock_out_method = 'auto', status = 'completed',
         work_seconds = CASE WHEN due.presence_only THEN 0
           ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (due.cutoff - due.clock_in_at))))::int END,
         notes = CASE WHEN s.notes LIKE '%Auto clocked out by system%' THEN s.notes
           ELSE concat_ws(E'\\n', NULLIF(s.notes, ''),
             'Auto clocked out by system at ' || due.cutoff::text || ' (18:00 Africa/Harare).') END,
         updated_at = NOW()
     FROM due WHERE s.id = due.id AND s.status = 'active' AND s.clock_out_at IS NULL`,
    [organizationId, userId ?? null, now],
  );
  return result.rowCount ?? 0;
}
