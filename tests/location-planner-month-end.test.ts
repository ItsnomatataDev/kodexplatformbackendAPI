import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isLocationPlannerMonthEndWindow,
  lastDateOfMonth,
  monthEndReminderDedupeKey,
  monthStartFromDateKey,
  nextMonthStartFromDateKey,
  previousMonthEndFromDateKey,
  previousMonthStartFromDateKey,
} from '../src/location-planner/month-end.js';

test('month-end helpers name the next roster month', () => {
  assert.equal(monthStartFromDateKey('2026-11-28'), '2026-11-01');
  assert.equal(nextMonthStartFromDateKey('2026-11-28'), '2026-12-01');
  assert.equal(nextMonthStartFromDateKey('2026-12-31'), '2027-01-01');
  assert.equal(previousMonthStartFromDateKey('2026-11-02'), '2026-10-01');
  assert.equal(previousMonthEndFromDateKey('2026-11-02'), '2026-10-31');
  assert.equal(previousMonthStartFromDateKey('2026-01-15'), '2025-12-01');
  assert.equal(previousMonthEndFromDateKey('2026-01-15'), '2025-12-31');
  assert.equal(lastDateOfMonth('2026-11-02'), 30);
  assert.equal(lastDateOfMonth('2026-02-01'), 28);
  assert.equal(
    monthEndReminderDedupeKey('org', '2026-12-01'),
    'location_planner_month_end:org:2026-12-01',
  );
});

test('month-end reminder window is the last three days', () => {
  assert.equal(
    isLocationPlannerMonthEndWindow(new Date('2026-11-27T10:00:00+02:00')),
    false,
  );
  assert.equal(
    isLocationPlannerMonthEndWindow(new Date('2026-11-28T08:00:00+02:00')),
    true,
  );
  assert.equal(
    isLocationPlannerMonthEndWindow(new Date('2026-11-30T18:00:00+02:00')),
    true,
  );
  assert.equal(
    isLocationPlannerMonthEndWindow(new Date('2026-12-01T08:00:00+02:00')),
    false,
  );
});
