import { Hono } from 'hono';
import { env } from '../config/env.js';
import { checkDatabaseHealth } from '../db/health.js';

const health = new Hono();

async function readinessPayload() {
  const database = await checkDatabaseHealth();

  return {
    status: database ? 'ok' : 'not_ready',
    service: 'kode-platform',
    environment: env.appEnv,
    checks: {
      database: database ? 'ok' : 'error',
    },
    timestamp: new Date().toISOString(),
  };
}

health.get('/live', (c) => {
  return c.json({
    status: 'ok',
    service: 'kode-platform',
    environment: env.appEnv,
    timestamp: new Date().toISOString(),
  });
});

health.get('/ready', async (c) => {
  try {
    const payload = await readinessPayload();
    return c.json(payload, payload.status === 'ok' ? 200 : 503);
  } catch {
    return c.json({
      status: 'not_ready',
      service: 'kode-platform',
      environment: env.appEnv,
      checks: {
        database: 'error',
      },
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

health.get('/', async (c) => {
  try {
    const payload = await readinessPayload();

    return c.json({
      ...payload,
      status: payload.status === 'ok' ? 'ok' : 'degraded',
    }, payload.status === 'ok' ? 200 : 503);
  } catch {
    return c.json({
      status: 'degraded',
      service: 'kode-platform',
      environment: env.appEnv,
      checks: {
        database: 'error',
      },
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

export default health;
