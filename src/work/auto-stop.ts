import { withTransaction } from '../db/transaction.js';
import { endOfDaySql } from '../attendance/end-of-day.js';
import { logger } from '../config/logger.js';

type TimerScope = { organizationId?: string; userId?: string; cardId?: string };

/** Close overdue timers even when no browser is open, including after downtime. */
export async function runTimeEntryAutoStop(now = new Date(), scope: TimerScope = {}) {
  let stopped = 0;
  for (;;) {
    const count = await withTransaction(async (client) => {
      const result = await client.query<{ card_id: string; organization_id: string }>(
        `WITH due AS (
           SELECT entry.id, ${endOfDaySql('entry.started_at')} AS cutoff
           FROM work.time_entries entry
           WHERE entry.started_at IS NOT NULL AND entry.ended_at IS NULL
             AND entry.deleted_at IS NULL
             AND ($2::uuid IS NULL OR entry.organization_id = $2)
             AND ($3::uuid IS NULL OR entry.user_id = $3)
             AND ($4::uuid IS NULL OR entry.card_id = $4)
             AND ${endOfDaySql('entry.started_at')} <= $1::timestamptz
           ORDER BY entry.id
           LIMIT 500 FOR UPDATE OF entry SKIP LOCKED
         )
         UPDATE work.time_entries entry
         SET ended_at = due.cutoff, auto_stopped_at = due.cutoff,
             seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (due.cutoff - entry.started_at))))::int,
             updated_at = NOW()
         FROM due WHERE entry.id = due.id
         RETURNING entry.card_id, entry.organization_id`,
        [now, scope.organizationId ?? null, scope.userId ?? null, scope.cardId ?? null],
      );
      if (!result.rows.length) return 0;
      const cardIds = [...new Set(result.rows.map((row) => row.card_id))];
      // Serialize cache refreshes with other time writes, then use a fresh snapshot.
      await client.query(
        'SELECT id FROM work.cards WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [cardIds],
      );
      await client.query(
        `UPDATE work.cards card SET tracked_seconds_cache = COALESCE((
           SELECT SUM(entry.seconds) FROM work.time_entries entry
           WHERE entry.card_id = card.id AND entry.organization_id = card.organization_id
             AND entry.deleted_at IS NULL
         ), 0) WHERE card.id = ANY($1::uuid[])`, [cardIds],
      );
      return result.rows.length;
    });
    stopped += count;
    if (count < 500) break;
  }
  if (stopped) logger.info({ stopped, cutoff: '18:00 Africa/Harare' }, 'Task timers automatically stopped.');
  return { stopped };
}
