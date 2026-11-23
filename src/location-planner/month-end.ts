import { harareDateKey } from '../attendance/harare.js';

export function monthStartFromDateKey(dateKey: string) {
  return `${dateKey.slice(0, 7)}-01`;
}

export function nextMonthStartFromDateKey(dateKey: string) {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
}

export function previousMonthStartFromDateKey(dateKey: string) {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${String(prevYear).padStart(4, '0')}-${String(prevMonth).padStart(2, '0')}-01`;
}

export function previousMonthEndFromDateKey(dateKey: string) {
  const start = monthStartFromDateKey(dateKey);
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7));
  return new Date(Date.UTC(year, month - 1, 0, 12)).toISOString().slice(0, 10);
}

export function lastDateOfMonth(dateKey: string) {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  return last;
}

/** Last three calendar days of the month in Africa/Harare. */
export function isLocationPlannerMonthEndWindow(now = new Date()) {
  const dateKey = harareDateKey(now);
  const day = Number(dateKey.slice(8, 10));
  return day >= lastDateOfMonth(dateKey) - 2;
}

export function monthEndReminderDedupeKey(organizationId: string, nextMonthStart: string) {
  return `location_planner_month_end:${organizationId}:${nextMonthStart}`;
}
