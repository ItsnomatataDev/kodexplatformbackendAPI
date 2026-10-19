import pg from 'pg';
import type { InfrastructureConfig } from '../config.js';
export function infrastructurePool(
  config: Pick<InfrastructureConfig, 'databaseUrl'>,
) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
    application_name: 'kodex-infrastructure',
    options: '-c search_path=pg_catalog',
  });
  pool.on('error', () =>
    console.error('Infrastructure database connection interrupted'),
  );
  return pool;
}
export async function checkDatabaseRole(
  pool: pg.Pool,
  role: 'kode_infra_runtime' | 'kode_infra_provisioner',
) {
  const result = await pool.query(
    `SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
   EXISTS(SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolcreatedb OR elevated.rolcreaterole OR elevated.rolbypassrls OR elevated.rolreplication) AND pg_has_role(current_user,elevated.oid,'member')) AS elevated_membership,
   pg_has_role(current_user,$1,'member') AS member,
   pg_has_role(current_user,'kode_infra_owner','member') AS owner,
   pg_has_role(current_user,(SELECT datdba FROM pg_database WHERE datname=current_database()),'member') AS database_owner,
   pg_has_role(current_user,$2,'member') AS opposite FROM pg_roles r WHERE r.rolname=current_user`,
    [
      role,
      role === 'kode_infra_runtime'
        ? 'kode_infra_provisioner'
        : 'kode_infra_runtime',
    ],
  );
  const r = result.rows[0];
  if (
    !r ||
    !r.member ||
    r.owner ||
    r.database_owner ||
    r.opposite ||
    r.elevated_membership ||
    r.rolsuper ||
    r.rolcreatedb ||
    r.rolcreaterole ||
    r.rolbypassrls
  )
    throw new Error(
      'Infrastructure requires a dedicated restricted database identity',
    );
}
export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
