import { db } from '../../src/db/pool.js';
import { harareTimeToday } from '../../src/attendance/harare.js';
import {
  emailIfPossible,
  harareDateKey,
  listActiveMembers,
  listClockedInUserIds,
  listOrganizations,
  logger,
  newEntityId,
  notifyAttendance,
  NOTIFICATION_TYPES,
  scheduleForOrg,
  shouldRunWeekdayJob,
  todayRange,
  upsertDailyStatus,
} from './attendance-shared.js';

/**
 * 08:30 Africa/Harare late marking + late email for members not clocked in.
 *
 * Cron (UTC weekdays):
 *   30 6 * * 1-5  cd /path/to/kode-platform && npm run job:attendance:mark-late
 */
async function main() {
  const now = new Date();
  const dateKey = harareDateKey(now);
  const { start, end } = todayRange(now);
  const orgs = await listOrganizations();

  let markedLate = 0;
  let emailed = 0;
  let skipped = 0;

  for (const org of orgs) {
    const schedule = scheduleForOrg(org);
    if (!shouldRunWeekdayJob(schedule, now)) {
      skipped += 1;
      continue;
    }

    const members = await listActiveMembers(org.id);
    const clockedIn = await listClockedInUserIds({
      organizationId: org.id,
      from: start,
      to: end,
    });
    const expectedClockIn = harareTimeToday(schedule.workdayStart, dateKey);

    for (const member of members) {
      if (clockedIn.has(member.userId)) continue;

      await upsertDailyStatus({
        organizationId: org.id,
        userId: member.userId,
        officeId: member.officeId,
        attendanceDate: dateKey,
        status: 'late',
        expectedClockInAt: expectedClockIn,
      });

      const name = member.fullName?.trim() || 'there';
      const title = 'You are marked late';
      const message = `Hi ${name}. You were not clocked in by ${schedule.lateAfter} (Africa/Harare) and have been marked late for ${org.name}. Please clock in as soon as you arrive.`;

      const result = await notifyAttendance({
        organizationId: org.id,
        recipientUserId: member.userId,
        type: NOTIFICATION_TYPES.attendanceLate,
        title,
        message,
        entityId: newEntityId(),
        dedupeKey: `attendance_late:${org.id}:${member.userId}:${dateKey}`,
        metadata: {
          dateKey,
          lateAfter: schedule.lateAfter,
          officeId: member.officeId,
        },
      });

      if (result === 'duplicate') continue;
      markedLate += 1;

      const sent = await emailIfPossible({
        to: member.email,
        subject: `[${org.name}] Late arrival notice`,
        text: `${message}\n\nOpen attendance: /attendance\n`,
      });
      if (sent) emailed += 1;
    }
  }

  logger.info(
    { markedLate, emailed, skippedOrgs: skipped, dateKey },
    'Attendance mark-late job finished.',
  );
}

main()
  .catch((error) => {
    console.error('Attendance mark-late failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
