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
    ssl: database.ssl
      ? {
          rejectUnauthorized: database.rejectUnauthorized,
          ...(database.ca ? { ca: database.ca } : {}),
        }
      : undefined,
  };
}
