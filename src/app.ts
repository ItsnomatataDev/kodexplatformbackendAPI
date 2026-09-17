import './types/hono.js';
import { Hono } from 'hono';
import { env } from './config/env.js';
import {
  createDefaultAuthDependencies,
  createDefaultAuthLifecycle,
  createDefaultMeDependencies,
} from './auth/defaults.js';
import { createAuthMiddleware } from './auth/middleware.js';
import type { AuthDependencies } from './auth/middleware.js';
import { createAuthRoutes, type AuthRouteDependencies } from './auth/routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestContext } from './middleware/request-context.js';
import { corsMiddleware } from './middleware/cors.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { securityHeadersMiddleware } from './middleware/security-headers.js';
import health from './routes/health.js';
import { createMeRoutes, type MeRouteDependencies } from './routes/me.js';
import { createBoardRoutes } from './routes/boards.js';
import {
  createBoardColumnRoutes,
  createColumnRoutes,
} from './routes/columns.js';
import { createBoardCardRoutes, createCardRoutes } from './routes/cards.js';
import { PostgresBoardStore } from './work/postgres-store.js';
import type { WorkStore } from './work/store.js';

export type CreateAppOptions = {
  auth?: AuthDependencies;
  me?: MeRouteDependencies;
  authLifecycle?: AuthRouteDependencies;
  corsOrigins?: string[];
  boards?: WorkStore;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();
  const authDependencies = options.auth ?? createDefaultAuthDependencies();
  const meDependencies = options.me ?? createDefaultMeDependencies();
  const authLifecycle =
    options.authLifecycle ?? createDefaultAuthLifecycle(authDependencies);
  const corsOrigins = options.corsOrigins ?? env.cors.allowedOrigins;
  const boards = options.boards ?? new PostgresBoardStore();

  app.use('*', securityHeadersMiddleware(env.appEnv));
  app.use('*', corsMiddleware(corsOrigins));
  app.use('*', requestContext);
  app.use('*', csrfMiddleware(corsOrigins));
  app.onError(errorHandler);

  app.get('/', (c) => {
    return c.json({
      name: 'Kode Platform API',
      version: '0.1.0',
      status: 'running',
    });
  });

  app.route('/health', health);
  app.route('/auth', createAuthRoutes(authLifecycle));

  const api = new Hono();
  api.use('*', createAuthMiddleware(authDependencies));
  api.route('/me', createMeRoutes(meDependencies));
  api.route('/boards', createBoardCardRoutes({ store: boards }));
  api.route('/boards', createBoardColumnRoutes({ store: boards }));
  api.route('/boards', createBoardRoutes({ store: boards }));
  api.route('/columns', createColumnRoutes({ store: boards }));
  api.route('/cards', createCardRoutes({ store: boards }));
  app.route('/api', api);

  return app;
}
