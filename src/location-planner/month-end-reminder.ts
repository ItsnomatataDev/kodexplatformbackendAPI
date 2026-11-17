import { db } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { harareDateKey } from '../attendance/harare.js';
import { APP_URL } from '../email/branded-templates.js';
import { sendAttendanceEmail } from '../email/attendance-mailer.js';
import { PostgresNotificationStore } from '../notifications/postgres-store.js';
import { NOTIFICATION_TYPES } from '../notifications/store.js';
import {
  isLocationPlannerMonthEndWindow,
  lastDateOfMonth,
  monthEndReminderDedupeKey,
  monthStartFromDateKey,
  nextMonthStartFromDateKey,
} from './month-end.js';

const notifications = new PostgresNotificationStore();
const sentThisProcess = new Set<string>();

function monthLabel(monthStart: string) {
  const date = new Date(`${monthStart}T12:00:00+02:00`);
  return new Intl.DateTimeFormat('en-ZW', {
    timeZone: 'Africa/Harare',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

async function listPlannerOrgsWithCurrentMonth(monthStart: string, monthEnd: string) {
  const result = await db.query<{ organization_id: string }>(
    `
      SELECT DISTINCT organization_id
      FROM location_planner.employee_assignments
      WHERE status <> 'cancelled'
        AND start_date >= $1::date
        AND start_date <= $2::date
    `,
    [monthStart, monthEnd],
  );
  return result.rows.map((row) => row.organization_id);
}

async function listPlannerManagers(organizationId: string) {
  const result = await db.query<{
    user_id: string;
    email: string | null;
    full_name: string | null;
  }>(
    `
      SELECT membership.user_id, users.email, profile.full_name
      FROM organizations.memberships membership
      JOIN organizations.roles role
        ON role.id = membership.role_id
      JOIN identity.users users
        ON users.id = membership.user_id
      LEFT JOIN identity.user_profiles profile
        ON profile.user_id = membership.user_id
      WHERE membership.organization_id = $1
        AND membership.status = 'active'
        AND users.is_active = TRUE
        AND users.account_status = 'active'
        AND users.deleted_at IS NULL
        AND (
          role.is_admin_role = TRUE
          OR role.is_manager_role = TRUE
          OR role.role_key = 'it'
        )
    `,
    [organizationId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    fullName: row.full_name,
  }));
}

export async function runLocationPlannerMonthEndReminder(now = new Date()) {
  if (!isLocationPlannerMonthEndWindow(now)) {
    return { skipped: true, sent: 0 };
  }

  const today = harareDateKey(now);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Harare',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  if (hour < 8) {
    return { skipped: true, sent: 0 };
  }

  const currentMonthStart = monthStartFromDateKey(today);
  const nextMonthStart = nextMonthStartFromDateKey(today);
  const currentMonthEnd = `${today.slice(0, 7)}-${String(lastDateOfMonth(today)).padStart(2, '0')}`;
  const currentLabel = monthLabel(currentMonthStart);
  const nextLabel = monthLabel(nextMonthStart);
  const origin = (env.appPublicUrl || APP_URL).replace(/\/+$/, '');
  const actionUrl = `${origin}/admin/location-planner`;

  const orgIds = await listPlannerOrgsWithCurrentMonth(currentMonthStart, currentMonthEnd);
  let sent = 0;

  for (const organizationId of orgIds) {
    const managers = await listPlannerManagers(organizationId);
    for (const manager of managers) {
      const processKey = `${organizationId}:${manager.userId}:${nextMonthStart}:${today}`;
      if (sentThisProcess.has(processKey)) {
        continue;
      }

      const created = await notifications.create({
        organizationId,
        recipientUserId: manager.userId,
        type: NOTIFICATION_TYPES.locationPlannerMonthEnd,
        title: `Location Planner · ${nextLabel}`,
        message: `Keep ${currentLabel}'s roster for ${nextLabel}, or build a new one? Open Location Planner to choose.`,
        entityType: 'location_planner_month',
        entityId: nextMonthStart,
        actionUrl: '/admin/location-planner',
        priority: 'high',
        category: 'operations',
        dedupeKey: monthEndReminderDedupeKey(organizationId, nextMonthStart),
        metadata: {
          currentMonthStart,
          nextMonthStart,
        },
      });

      sentThisProcess.add(processKey);
      if (created === 'duplicate') {
        continue;
      }

      const email = manager.email?.trim().toLowerCase();
      if (email) {
        try {
          await sendAttendanceEmail({
            to: email,
            firstName: manager.fullName ?? undefined,
            subject: `Location Planner: keep ${currentLabel} for ${nextLabel}?`,
            actionUrl,
            actionLabel: 'Open Location Planner',
            text: [
              `${currentLabel} is ending.`,
              '',
              `Do you want to continue the current Location Planner roster into ${nextLabel}, or create a new one?`,
              '',
              `Open Location Planner and choose “Use this roster next month” to copy placements onto empty days, or start ${nextLabel} from scratch.`,
            ].join('\n'),
          });
        } catch (error) {
          logger.warn(
            { err: error, organizationId, userId: manager.userId },
            'Location planner month-end email failed',
          );
        }
      }
      sent += 1;
    }
  }

  if (sent > 0) {
    logger.info({ sent, nextMonthStart }, 'Location planner month-end reminders sent');
  }
  return { skipped: false, sent };
}
