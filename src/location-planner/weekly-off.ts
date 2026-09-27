/** Expand a weekly off rule onto concrete dates in [startDate, endDate]. weekday: 0=Sun .. 6=Sat. */
export function expandWeeklyOffDates(startDate: string, endDate: string, weekday: number): string[] {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return [];
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T12:00:00.000Z`);
  const end = new Date(`${endDate}T12:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || cursor > end) return [];
  while (cursor <= end) {
    if (cursor.getUTCDay() === weekday) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
