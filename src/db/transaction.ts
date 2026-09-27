import type { PoolClient } from 'pg';
import { db } from './pool.js';

export type TransactionClient = PoolClient;

export async function withTransaction<T>(
  work: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  let sessionError: Error | undefined;
  const onSessionError = (error: Error) => {
    sessionError = error;
  };
  // An idle-in-transaction timeout emits here with no active query.
  // Without a listener, Node treats that as an uncaught exception.
  client.on('error', onSessionError);

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!sessionError) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.removeListener('error', onSessionError);
    client.release(sessionError);
  }
}
