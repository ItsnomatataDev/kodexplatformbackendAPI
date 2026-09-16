import { db } from './pool.js';

export async function checkDatabaseHealth() {
  const result = await db.query('SELECT 1 AS ok');

  return result.rows[0]?.ok === 1;
}
