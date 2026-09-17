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
import {
  createAttachmentRoutes,
  createCardNestedRoutes,
  createCommentRoutes,
  createLabelRoutes,
  createSubmissionRoutes,
  createTimeEntryRoutes,
} from './routes/card-ecosystem.js';
import { MemoryFileStorage } from './files/memory-storage.js';
import { MinioFileStorage } from './files/minio-storage.js';
import type { FileStorage } from './files/storage.js';
import { PostgresBoardStore } from './work/postgres-store.js';
import type { WorkStore } from './work/store.js';

export type CreateAppOptions = {
  auth?: AuthDependencies;
  me?: MeRouteDependencies;
  authLifecycle?: AuthRouteDependencies;
  corsOrigins?: string[];
  boards?: WorkStore;
  files?: FileStorage;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();
  const authDependencies = options.auth ?? createDefaultAuthDependencies();
  const meDependencies = options.me ?? createDefaultMeDependencies();
  const authLifecycle =
    options.authLifecycle ?? createDefaultAuthLifecycle(authDependencies);
  const corsOrigins = options.corsOrigins ?? env.cors.allowedOrigins;
  const boards = options.boards ?? new PostgresBoardStore();
  const files =
    options.files ??
    (env.minio.accessKey && env.minio.secretKey
      ? new MinioFileStorage()
      : new MemoryFileStorage());

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
  api.route('/cards', createCardNestedRoutes({ store: boards, files }));
  api.route('/cards', createCardRoutes({ store: boards }));
  api.route('/comments', createCommentRoutes({ store: boards, files }));
  api.route('/labels', createLabelRoutes({ store: boards, files }));
  api.route('/submissions', createSubmissionRoutes({ store: boards, files }));
  api.route('/attachments', createAttachmentRoutes({ store: boards, files }));
  api.route('/time-entries', createTimeEntryRoutes({ store: boards, files }));
  app.route('/api', api);

  return app;
}
