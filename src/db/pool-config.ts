import type { PoolConfig } from 'pg';

export type PostgresConnectionSettings = {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
  rejectUnauthorized: boolean;
  ca?: string;
};

/**
 * How long PostgreSQL may run one statement before cancelling it.
 * This is not the pool wait (`connectionTimeoutMillis`).
 * Migrations raise this inside their own transaction.
 */
export const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * How long a transaction may sit idle between statements before
 * PostgreSQL ends that session. In-flight statements use statement_timeout.
 */
export const IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 60_000;

export function postgresPoolConfig(
  database: PostgresConnectionSettings,
): PoolConfig {
  return {
    host: database.host,
    port: database.port,
    database: database.name,
    user: database.user,
    password: database.password,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    ssl: database.ssl
      ? {
          rejectUnauthorized: database.rejectUnauthorized,
          ...(database.ca ? { ca: database.ca } : {}),
        }
      : undefined,
  };
}
