import { Hono } from 'hono';

const health = new Hono();

health.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'kode-platform',
    timestamp: new Date().toISOString(),
  });
});

export default health;
