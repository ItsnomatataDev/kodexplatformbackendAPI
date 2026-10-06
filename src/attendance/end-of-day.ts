/** Both attendance and task timers stop at 18:00 Africa/Harare each day. */
export const END_OF_DAY_TIME = '18:00';

/**
 * A segment explicitly started at/after 18:00 runs until the next day's cutoff.
 * `column` is an internal SQL identifier, never client input.
 */
export function endOfDaySql(column: string) {
  const local = `(${column} AT TIME ZONE 'Africa/Harare')`;
  return `((${local}::date + TIME '18:00'
    + CASE WHEN ${local}::time >= TIME '18:00' THEN INTERVAL '1 day'
      ELSE INTERVAL '0 days' END) AT TIME ZONE 'Africa/Harare')`;
}
