import type { PoolClient } from 'pg';
import { db } from './pool.js';

export type TransactionClient = PoolClient;

export async function withTransaction<T>(
  work: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
