import { logger } from '../config/logger.js';
import { runAttendanceAutoClockOut } from './auto-clock-out.js';

const TICK_MS = 60_000;

/** Keep the 18:00 Africa/Harare auto clock-out running with the API. */
export function startAttendanceScheduler() {
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runAttendanceAutoClockOut();
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
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}
