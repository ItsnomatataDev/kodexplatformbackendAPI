import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDateKey } from '../src/location-planner/dates.js';
import { expandWeeklyOffDates } from '../src/location-planner/weekly-off.js';

test('expandWeeklyOffDates returns only matching weekdays', () => {
  // 2026-09-21 Mon .. 2026-09-27 Sun; Wednesday=3
  const wed = expandWeeklyOffDates('2026-09-21', '2026-09-27', 3);
  assert.deepEqual(wed, ['2026-09-23']);

  const mon = expandWeeklyOffDates('2026-09-21', '2026-09-27', 1);
  assert.deepEqual(mon, ['2026-09-21']);

  const sun = expandWeeklyOffDates('2026-09-21', '2026-09-27', 0);
  assert.deepEqual(sun, ['2026-09-27']);

  const sat = expandWeeklyOffDates('2026-09-21', '2026-09-27', 6);
  assert.deepEqual(sat, ['2026-09-26']);
});

test('expandWeeklyOffDates spans multiple weeks', () => {
  const mondays = expandWeeklyOffDates('2026-09-01', '2026-09-30', 1);
  assert.deepEqual(mondays, ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
});

test('calendarDateKey keeps the local calendar day', () => {
  assert.equal(calendarDateKey(new Date(2026, 8, 23, 0, 0, 0)), '2026-09-23');
});

test('expandWeeklyOffDates rejects invalid weekday', () => {
  assert.deepEqual(expandWeeklyOffDates('2026-09-21', '2026-09-27', 7), []);
  assert.deepEqual(expandWeeklyOffDates('2026-09-21', '2026-09-27', -1), []);
});
