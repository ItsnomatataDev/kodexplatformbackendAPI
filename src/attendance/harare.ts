export function harareDateKey(value = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function harareWeekday(value = new Date()): number {

  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Harare',
    weekday: 'short',
  }).format(value);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[label] ?? value.getUTCDay();
}

export function isHarareWeekday(value = new Date()): boolean {
  const day = harareWeekday(value);
  return day >= 1 && day <= 5;
}

export function harareDayRange(dateKey = harareDateKey()) {
  const start = new Date(`${dateKey}T00:00:00+02:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end, dateKey };
}

function addDateKey(key: string, days: number) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 18:00 on the clock-in day, or the next day when the session started after cutoff. */
export function autoClockOutBoundary(clockInAt: Date, autoClockOut: string) {
  const clockInKey = harareDateKey(clockInAt);
  const sameDay = harareTimeToday(autoClockOut, clockInKey);
  if (clockInAt.getTime() < sameDay.getTime()) return sameDay;
  return harareTimeToday(autoClockOut, addDateKey(clockInKey, 1));
}

export function harareTimeToday(hhmm: string, dateKey = harareDateKey()): Date {
  const [hours, minutes] = hhmm.split(':').map((part) => Number(part));
  const h = Number.isFinite(hours) ? hours : 0;
  const m = Number.isFinite(minutes) ? minutes : 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  return new Date(`${dateKey}T${pad(h)}:${pad(m)}:00+02:00`);
}

export function secondsBetween(start: Date | string, end: Date | string) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

export function isPresenceOnlySettings(
  settings: Record<string, unknown> | null | undefined,
) {
  return settings?.attendance_mode === 'presence_only';
}

export type AttendanceSchedule = {
  timezone: string;
  workdayStart: string;
  clockInReminder: string;
  lateAfter: string;
  autoClockOut: string;
  weekdaysOnly: boolean;
};

export const DEFAULT_ATTENDANCE_SCHEDULE: AttendanceSchedule = {
  timezone: 'Africa/Harare',
  workdayStart: '08:00',
  clockInReminder: '08:15',
  lateAfter: '08:30',
  autoClockOut: '18:00',
  weekdaysOnly: true,
};

export function parseAttendanceSchedule(
  settings: Record<string, unknown> | null | undefined,
): AttendanceSchedule {
  const raw =
    settings?.attendance && typeof settings.attendance === 'object'
      ? (settings.attendance as Record<string, unknown>)
      : {};
  return {
    timezone:
      typeof raw.timezone === 'string' ? raw.timezone : DEFAULT_ATTENDANCE_SCHEDULE.timezone,
    workdayStart:
      typeof raw.workday_start === 'string'
        ? raw.workday_start
        : DEFAULT_ATTENDANCE_SCHEDULE.workdayStart,
    clockInReminder:
      typeof raw.clock_in_reminder === 'string'
        ? raw.clock_in_reminder
        : DEFAULT_ATTENDANCE_SCHEDULE.clockInReminder,
    lateAfter:
      typeof raw.late_after === 'string'
        ? raw.late_after
        : DEFAULT_ATTENDANCE_SCHEDULE.lateAfter,
    autoClockOut:
      typeof raw.auto_clock_out === 'string'
        ? raw.auto_clock_out
        : DEFAULT_ATTENDANCE_SCHEDULE.autoClockOut,
    weekdaysOnly:
      typeof raw.weekdays_only === 'boolean'
        ? raw.weekdays_only
        : DEFAULT_ATTENDANCE_SCHEDULE.weekdaysOnly,
  };
}