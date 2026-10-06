import {
  autoClockOutBoundary,
  harareTimeToday,
} from './harare.js';
import {
  autoClockOutSession,
  harareDateKey,
  listActiveMembers,
  listActiveSessions,
  listClockedInUserIds,
  listOrganizations,
  logger,
  notifyAttendance,
  NOTIFICATION_TYPES,
  scheduleForOrg,
  shouldRunWeekdayJob,
  todayRange,
  upsertDailyStatus,
  type ActiveSessionRow,
} from './job-shared.js';
import { END_OF_DAY_TIME } from './end-of-day.js';

const absentMarked = new Set<string>();

/**
 * Close every open timer whose 18:00 Africa/Harare cutoff has passed.
 * Safe to call often: sessions already closed are left alone.
 */
export async function runAttendanceAutoClockOut(now = new Date()) {
  const dateKey = harareDateKey(now);
  const { start, end } = todayRange(now);
  const orgs = await listOrganizations();

  const sessions = await listActiveSessions();
  let clockedOut = 0;
  let skippedWeekend = 0;
  let failedSessions = 0;
  const closedSessions: ActiveSessionRow[] = [];

  for (const session of sessions) {
    try {
      const closed = await closeSessionIfDue(session, now);
      if (closed) {
        clockedOut += 1;
        closedSessions.push(session);
      }
    } catch (error) {
      failedSessions += 1;
      logger.error({ err: error, sessionId: session.id, userId: session.userId },
        'Attendance auto clock-out failed for session; continuing with other profiles');
    }
  }

  // Finish all clock-outs before any notification I/O can delay another profile.
  for (let offset = 0; offset < closedSessions.length; offset += 10) {
    await Promise.all(closedSessions.slice(offset, offset + 10).map(notifyAutoClockOut));
  }

  let markedAbsent = 0;
  for (const org of orgs) {
    const schedule = scheduleForOrg(org);
    const cutoff = harareTimeToday(END_OF_DAY_TIME, dateKey);
    // Do not mark people absent before the 18:00 cutoff. Morning ticks
    // would otherwise stamp the whole team absent before they clock in.
    if (now.getTime() < cutoff.getTime()) continue;
    if (!shouldRunWeekdayJob(schedule, now)) {
      skippedWeekend += 1;
      continue;
    }
    const markKey = `${org.id}:${dateKey}`;
    if (absentMarked.has(markKey)) continue;

    const members = await listActiveMembers(org.id);
    const clockedIn = await listClockedInUserIds({
      organizationId: org.id,
      from: start,
      to: end,
    });

    let allMarked = true;
    for (const member of members) {
      if (clockedIn.has(member.userId)) continue;
      try {
        await upsertDailyStatus({
          organizationId: org.id,
          userId: member.userId,
          officeId: member.officeId,
          attendanceDate: dateKey,
          status: 'absent',
        });
        markedAbsent += 1;
      } catch (error) {
        allMarked = false;
        logger.error({ err: error, organizationId: org.id, userId: member.userId },
          'Attendance absence update failed; will retry');
      }
    }
    if (allMarked) absentMarked.add(markKey);
  }

  if (clockedOut > 0 || markedAbsent > 0) {
    logger.info(
      { clockedOut, markedAbsent, skippedWeekend, dateKey },
      'Attendance auto clock-out job finished.',
    );
  }

  return { clockedOut, markedAbsent, skippedWeekend, failedSessions, dateKey };
}

async function closeSessionIfDue(
  session: ActiveSessionRow,
  now: Date,
) {
  const clockOutAt = autoClockOutBoundary(session.clockInAt, END_OF_DAY_TIME);
  if (now.getTime() < clockOutAt.getTime()) return false;

  return autoClockOutSession(session, clockOutAt);
}

async function notifyAutoClockOut(session: ActiveSessionRow) {
  const clockOutAt = autoClockOutBoundary(session.clockInAt, END_OF_DAY_TIME);
  try {
    await notifyAttendance({
      organizationId: session.organizationId,
      recipientUserId: session.userId,
      type: NOTIFICATION_TYPES.attendanceAutoClockOut,
      title: 'Auto clocked out',
      message: `Your attendance was automatically clocked out at ${END_OF_DAY_TIME} (Africa/Harare).`,
      entityId: session.id,
      dedupeKey: `attendance_auto_clock_out:${session.id}`,
      metadata: {
        sessionId: session.id,
        clockOutAt: clockOutAt.toISOString(),
        dateKey: harareDateKey(clockOutAt),
      },
    });
  } catch (error) {
    // Notification delivery must never prevent the rest of the team being closed.
    logger.error({ err: error, sessionId: session.id, userId: session.userId },
      'Attendance auto clock-out notification failed; session remains closed');
  }
}
