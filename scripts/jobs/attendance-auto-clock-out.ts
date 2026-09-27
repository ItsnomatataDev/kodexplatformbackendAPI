/**
 * CLI entry for cron:
 *   0 16 * * *  cd /path/to/kode-platform && npm run job:attendance:auto-clock-out
 * The API also runs this every minute via startAttendanceScheduler().
 */
import { db } from '../../src/db/pool.js';
import { runAttendanceAutoClockOut } from '../../src/attendance/auto-clock-out.js';

runAttendanceAutoClockOut()
  .catch((error) => {
    console.error('Attendance auto clock-out failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
