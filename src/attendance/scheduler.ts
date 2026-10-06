import { logger } from '../config/logger.js';
import { runAttendanceAutoClockOut } from './auto-clock-out.js';
import { runTimeEntryAutoStop } from '../work/auto-stop.js';

const TICK_MS = 60_000;

/** Run both daily cutoffs independently, every minute and immediately on startup. */
export function startAttendanceScheduler() {
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const results = await Promise.allSettled([
        runAttendanceAutoClockOut(),
        runTimeEntryAutoStop(),
      ]);
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error({ err: result.reason, job: index === 0 ? 'attendance' : 'time_entries' },
            'End-of-day job failed');
        }
      });
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Attendance auto clock-out tick failed',
      );
    } finally {
      ticking = false;
    }
  };

  void tick();
  logger.info({ intervalMs: TICK_MS, cutoff: '18:00 Africa/Harare', jobs: ['attendance', 'time_entries'] },
    'End-of-day scheduler started');
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}
