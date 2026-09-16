import { Hono } from 'hono';
import health from './routes/health.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp() {
  const app = new Hono();

  app.onError(errorHandler);

  app.get('/', (c) => {
    return c.json({
      name: 'Kode Platform API',
      version: '0.1.0',
      status: 'running',
    });
  });

  app.route('/health', health);

  return app;
}
