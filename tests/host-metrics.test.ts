import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinuxMemory, buildStorageSnapshot } from '../src/it/host-metrics.js';

test('Linux RAM pressure excludes reclaimable memory using MemAvailable', () => {
  const ram = parseLinuxMemory('MemTotal:       1000 kB\nMemFree:          10 kB\nMemAvailable:    600 kB\n');
  assert.equal(ram?.usedBytes, 400 * 1024);
  assert.equal(ram?.percent, 40);
  assert.equal(parseLinuxMemory('MemTotal: 1000 kB\n'), null);
});

test('missing readings and unmeasured breakdowns stay unknown; history is not fabricated', () => {
  const snapshot = buildStorageSnapshot({ databaseBytes: null, storageBytes: 100, disk: { usedBytes: 1000, totalBytes: 2000, source: 'df' }, ram: { usedBytes: 400, totalBytes: 1000, availableBytes: 600, percent: 40 } });
  assert.equal(snapshot.appUsedBytes, null);
  assert.equal(snapshot.diskPercent, 50);
  assert.equal(snapshot.diskBreakdown.backupsBytes, null);
  assert.equal(snapshot.diskBreakdown.otherBytes, null);
  assert.deepEqual(snapshot.history, []);
});
