import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { postgresPoolConfig } from './pool-config.js';

const { Pool } = pg;

export const db = new Pool(postgresPoolConfig(env.database));

db.on('error', (error) => {
  logger.error({ err: error }, 'Unexpected PostgreSQL pool error');
});
