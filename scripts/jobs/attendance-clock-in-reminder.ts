import { db } from '../../src/db/pool.js';
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
} from './attendance-shared.js';

/**
 * 08:15 Africa/Harare clock-in reminder for members not yet clocked in.
 *
 * Cron (UTC weekdays):
 *   15 6 * * 1-5  cd /path/to/kode-platform && npm run job:attendance:clock-in-reminder
 */
async function main() {
  const now = new Date();
  const dateKey = harareDateKey(now);
  const { start, end } = todayRange(now);
  const orgs = await listOrganizations();

  let reminded = 0;
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

    for (const member of members) {
      if (clockedIn.has(member.userId)) continue;

      const name = member.fullName?.trim() || 'there';
      const title = 'Clock-in reminder';
      const message = `Good morning ${name}. Please clock in for ${org.name} — workday started at ${schedule.workdayStart} (Africa/Harare).`;

      const result = await notifyAttendance({
        organizationId: org.id,
        recipientUserId: member.userId,
        type: NOTIFICATION_TYPES.attendanceClockInReminder,
        title,
        message,
        entityId: newEntityId(),
        dedupeKey: `attendance_clock_in_reminder:${org.id}:${member.userId}:${dateKey}`,
        metadata: {
          dateKey,
          reminderAt: schedule.clockInReminder,
          officeId: member.officeId,
        },
      });

      if (result === 'duplicate') continue;
      reminded += 1;

      const sent = await emailIfPossible({
        to: member.email,
        subject: `[${org.name}] Clock-in reminder`,
        text: `${message}\n\nOpen attendance: /attendance\n`,
      });
      if (sent) emailed += 1;
    }
  }

  logger.info(
    { reminded, emailed, skippedOrgs: skipped, dateKey },
    'Attendance clock-in reminder job finished.',
  );
}

main()
  .catch((error) => {
    console.error('Attendance clock-in reminder failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
