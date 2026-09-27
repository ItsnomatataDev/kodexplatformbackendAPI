import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertWithinOfficeGeofences } from '../src/attendance/geofence.js';
import {
  DEFAULT_ATTENDANCE_SCHEDULE,
  autoClockOutBoundary,
  harareDateKey,
  harareTimeToday,
  parseAttendanceSchedule,
} from '../src/attendance/harare.js';

const tlbFence = {
  attendance_mode: 'time_tracked',
  geofence: {
    enabled: true,
    label: 'ZHC Helipad (Chinotimba)',
    latitude: -17.9382,
    longitude: 25.8325,
    radius_meters: 200,
  },
  geofences: [
    {
      enabled: true,
      label: 'ZHC Helipad (Chinotimba)',
      latitude: -17.9382,
      longitude: 25.8325,
      radius_meters: 200,
    },
  ],
};

test('geofence checks are off until site coordinates are confirmed', () => {
  assert.doesNotThrow(() =>
    assertWithinOfficeGeofences({
      settings: tlbFence,
      location: { latitude: -17.9382, longitude: 25.8325 },
    }),
  );
  assert.doesNotThrow(() =>
    assertWithinOfficeGeofences({
      settings: tlbFence,
      location: { latitude: -17.927709, longitude: 25.837663 },
    }),
  );
  assert.doesNotThrow(() =>
    assertWithinOfficeGeofences({
      settings: tlbFence,
      location: null,
    }),
  );
});

test('attendance schedule defaults match Harare workday rules', () => {
  const schedule = parseAttendanceSchedule({});
  assert.equal(schedule.timezone, 'Africa/Harare');
  assert.equal(schedule.clockInReminder, '08:15');
  assert.equal(schedule.lateAfter, '08:30');
  assert.equal(schedule.autoClockOut, '18:00');
  assert.equal(schedule.weekdaysOnly, true);
  assert.deepEqual(schedule, DEFAULT_ATTENDANCE_SCHEDULE);
});

test('auto clock-out boundary is 18:00 on the clock-in day', () => {
  const clockIn = new Date('2026-09-23T06:15:00.000Z');
  const boundary = autoClockOutBoundary(clockIn, '18:00');
  assert.equal(boundary.toISOString(), '2026-09-23T16:00:00.000Z');
});

test('auto clock-out moves to the next day when clock-in is after 18:00', () => {
  const clockIn = new Date('2026-09-23T17:05:00.000Z');
  const boundary = autoClockOutBoundary(clockIn, '18:00');
  assert.equal(boundary.toISOString(), '2026-09-24T16:00:00.000Z');
});

test('harareTimeToday builds CAT (+02) timestamps', () => {
  const dateKey = harareDateKey(new Date('2026-09-18T10:00:00Z'));
  const late = harareTimeToday('08:30', dateKey);
  assert.equal(late.toISOString(), `${dateKey}T06:30:00.000Z`);
});
