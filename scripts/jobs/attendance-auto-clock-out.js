import { db } from '../../src/db/pool.js';
import { autoClockOutBoundary, harareTimeToday, } from '../../src/attendance/harare.js';
import { autoClockOutSession, harareDateKey, listActiveMembers, listActiveSessions, listClockedInUserIds, listOrganizations, logger, notifyAttendance, NOTIFICATION_TYPES, scheduleForOrg, shouldRunWeekdayJob, todayRange, upsertDailyStatus, } from './attendance-shared.js';
const absentMarked = new Set();
/**
 * Close every open timer whose 18:00 Africa/Harare cutoff has passed.
 * Safe to call often: sessions already closed are left alone.
 */
export async function runAttendanceAutoClockOut(now = new Date()) {
    const dateKey = harareDateKey(now);
    const { start, end } = todayRange(now);
    const orgs = await listOrganizations();
    const orgById = new Map(orgs.map((org) => [org.id, org]));
    const sessions = await listActiveSessions();
    let clockedOut = 0;
    let skippedWeekend = 0;
    for (const session of sessions) {
        const closed = await closeSessionIfDue(session, orgById, now);
        if (closed)
            clockedOut += 1;
    }
    let markedAbsent = 0;
    for (const org of orgs) {
        const schedule = scheduleForOrg(org);
        const cutoff = harareTimeToday(schedule.autoClockOut, dateKey);
        // Do not mark people absent before the 18:00 cutoff. Morning ticks
        // would otherwise stamp the whole team absent before they clock in.
        if (now.getTime() < cutoff.getTime())
            continue;
        if (!shouldRunWeekdayJob(schedule, now)) {
            skippedWeekend += 1;
            continue;
        }
        const markKey = `${org.id}:${dateKey}`;
        if (absentMarked.has(markKey))
            continue;
        absentMarked.add(markKey);
        const members = await listActiveMembers(org.id);
        const clockedIn = await listClockedInUserIds({
            organizationId: org.id,
            from: start,
            to: end,
        });
        for (const member of members) {
            if (clockedIn.has(member.userId))
                continue;
            await upsertDailyStatus({
                organizationId: org.id,
                userId: member.userId,
                officeId: member.officeId,
                attendanceDate: dateKey,
                status: 'absent',
            });
            markedAbsent += 1;
        }
    }
    if (clockedOut > 0 || markedAbsent > 0) {
        logger.info({ clockedOut, markedAbsent, skippedWeekend, dateKey }, 'Attendance auto clock-out job finished.');
    }
    return { clockedOut, markedAbsent, skippedWeekend, dateKey };
}
async function closeSessionIfDue(session, orgById, now) {
    const org = orgById.get(session.organizationId);
    if (!org)
        return false;
    const schedule = scheduleForOrg(org);
    const clockOutAt = autoClockOutBoundary(session.clockInAt, schedule.autoClockOut);
    if (now.getTime() < clockOutAt.getTime())
        return false;
    await autoClockOutSession(session, clockOutAt);
    await notifyAttendance({
        organizationId: session.organizationId,
        recipientUserId: session.userId,
        type: NOTIFICATION_TYPES.attendanceAutoClockOut,
        title: 'Auto clocked out',
        message: `Your attendance was automatically clocked out at ${schedule.autoClockOut} (Africa/Harare).`,
        entityId: session.id,
        dedupeKey: `attendance_auto_clock_out:${session.id}`,
        metadata: {
            sessionId: session.id,
            clockOutAt: clockOutAt.toISOString(),
            dateKey: harareDateKey(clockOutAt),
        },
    });
    return true;
}
/**
 * Cron (UTC):
 *   0 16 * * *  cd /path/to/kode-platform && npm run job:attendance:auto-clock-out
 * The API also runs this every minute while it is up.
 */
const entry = process.argv[1] ?? '';
if (entry.includes('attendance-auto-clock-out')) {
    runAttendanceAutoClockOut()
        .catch((error) => {
        console.error('Attendance auto clock-out failed:', error);
        process.exitCode = 1;
    })
        .finally(async () => {
        await db.end();
    });
}
//# sourceMappingURL=attendance-auto-clock-out.js.map