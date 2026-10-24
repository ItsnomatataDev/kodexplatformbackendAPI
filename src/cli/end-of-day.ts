import { db } from '../db/pool.js';
import { runAttendanceAutoClockOut } from '../attendance/auto-clock-out.js';
import { runTimeEntryAutoStop } from '../work/auto-stop.js';

// Runs inside the API image with its runtime environment; no host npm required.
const results = await Promise.allSettled([
  runAttendanceAutoClockOut(),
  runTimeEntryAutoStop(),
]);
results.forEach((result, index) => {
  const job = index === 0 ? 'attendance' : 'time_entries';
  if (result.status === 'fulfilled') {
    console.log(JSON.stringify({ job, ...result.value }));
    if ('failedSessions' in result.value && result.value.failedSessions > 0) process.exitCode = 1;
  } else {
    console.error(`${job}:`, result.reason instanceof Error ? result.reason.message : result.reason);
    process.exitCode = 1;
  }
});
await db.end();
