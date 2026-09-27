import './types/hono.js';
import { Hono } from 'hono';
import { env } from './config/env.js';
import {createDefaultAuthDependencies, createDefaultAuthLifecycle,createDefaultMeDependencies,} from './auth/defaults.js';
import { createAuthMiddleware } from './auth/middleware.js';
import type { AuthDependencies } from './auth/middleware.js';
import { createAuthRoutes, type AuthRouteDependencies } from './auth/routes.js';
import type { RateLimiter } from './auth/rate-limit.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestContext } from './middleware/request-context.js';
import { corsMiddleware } from './middleware/cors.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { securityHeadersMiddleware } from './middleware/security-headers.js';
import { bodyLimitMiddleware } from './middleware/body-limit.js';
import { clientIpMiddleware } from './middleware/client-ip.js';
import health from './routes/health.js';
import { createMeRoutes, type MeRouteDependencies } from './routes/me.js';
import { createOrganizationRoutes } from './routes/organization.js';
import { createOfficeRoutes } from './routes/offices.js';
import { createRoleRoutes } from './routes/roles.js';
import { PostgresOrganizationDirectoryStore } from './organizations/postgres-store.js';
import type { OrganizationDirectoryStore } from './organizations/store.js';
import { createBoardRoutes } from './routes/boards.js';
import {
  createBoardColumnRoutes,
  createColumnRoutes,
} from './routes/columns.js';
import { createBoardCardRoutes, createCardRoutes } from './routes/cards.js';
import {
  createAttachmentRoutes,
  createCardNestedRoutes,
  createChecklistItemRoutes,
  createChecklistRoutes,
  createCommentRoutes,
  createLabelRoutes,
  createSubmissionRoutes,
  createTimeEntryRoutes,
} from './routes/card-ecosystem.js';
import { MemoryFileStorage } from './files/memory-storage.js';
import { MinioFileStorage } from './files/minio-storage.js';
import type { FileStorage } from './files/storage.js';
import { PostgresNotificationStore } from './notifications/postgres-store.js';
import type { NotificationStore } from './notifications/store.js';
import { createNotificationRoutes } from './routes/notifications.js';
import { PostgresTicketStore } from './tickets/postgres-store.js';
import type { TicketStore } from './tickets/store.js';
import { createTicketRoutes } from './routes/tickets.js';
import { PostgresAttendanceStore } from './attendance/postgres-store.js';
import type { AttendanceStore } from './attendance/store.js';
import { createAttendanceRoutes } from './routes/attendance.js';
import { PostgresChatStore } from './chat/postgres-store.js';
import type { ChatStore } from './chat/store.js';
import { createChatRoutes } from './routes/chat.js';
import { createChatWebSocketRoutes } from './routes/chat-ws.js';
import { PostgresContentStore } from './content/postgres-store.js';
import type { ContentStore } from './content/store.js';
import { createContentStudioRoutes } from './routes/content-studio.js';
import { createKodexRoutes } from './routes/kodex.js';
import { createContentPortalRoutes } from './routes/content-portal.js';
import { createContentPreviewRoutes } from './routes/content-preview.js';
import { createTicketPortalRoutes } from './routes/ticket-portal.js';
import { PostgresLeaveStore } from './leave/postgres-store.js';
import { createLeaveRoutes } from './routes/leave.js';
import { PostgresDocumentsStore } from './documents/postgres-store.js';
import { createDocumentsRoutes } from './routes/documents.js';
import { PostgresBrandingStore } from './organizations/branding-store.js';
import {
  createBrandingRoutes,
  createPublicBrandingRoutes,
} from './routes/branding.js';
import { PostgresDutyStore } from './duty/postgres-store.js';
import { createDutyRoutes } from './routes/duty-roster.js';
import { PostgresMediaStore } from './media/postgres-store.js';
import { createMediaRoutes } from './routes/media.js';
import { PostgresStockStore } from './stock/postgres-store.js';
import { createStockRoutes } from './routes/stock.js';
import { PostgresFleetStore } from './fleet/postgres-store.js';
import { createFleetRoutes } from './routes/fleet.js';
import { PostgresMeetingsStore } from './meetings/postgres-store.js';
import {
  createMeetingsRoutes,
  createPublicMeetingGuestRoutes,
} from './routes/meetings.js';
import { PostgresObligationsStore } from './obligations/postgres-store.js';
import { createObligationsRoutes } from './routes/obligations.js';
import { PostgresLocationPlannerStore } from './location-planner/postgres-store.js';
import { createLocationPlannerRoutes } from './routes/location-planner.js';
import { PostgresTourismStore } from './tourism/postgres-store.js';
import { createTourismRoutes } from './routes/tourism.js';
import { PostgresSocialStore } from './social/postgres-store.js';
import { createSocialRoutes } from './routes/social.js';
import { PostgresSecurityStore } from './security/postgres-store.js';
import {
  createSecurityIngestRoutes,
  createSecurityDecoyRoutes,
  createSecurityRoutes,
} from './routes/security.js';
import { PostgresUniversityStore } from './university/postgres-store.js';
import { createUniversityRoutes } from './routes/university.js';
import { PostgresItStore } from './it/postgres-store.js';
import { createItRoutes } from './routes/it.js';
import { PostgresAiStore } from './ai/postgres-store.js';
import { createAiRoutes } from './routes/ai.js';
import { createAutomationRoutes } from './routes/automation.js';
import { PostgresBoardStore } from './work/postgres-store.js';
import type { WorkStore } from './work/store.js';
import type { HttpLimits, WorkRateLimitPolicies } from './http/limits.js';


export type CreateAppOptions = {
  auth?: AuthDependencies;
  me?: MeRouteDependencies;
  organizationDirectory?: OrganizationDirectoryStore;
  authLifecycle?: AuthRouteDependencies;
  corsOrigins?: string[];
  boards?: WorkStore;
  notifications?: NotificationStore;
  tickets?: TicketStore;
  attendance?: AttendanceStore;
  chat?: ChatStore;
  content?: ContentStore;
  files?: FileStorage;
  trustedProxyIps?: string[];
  limits?: Partial<HttpLimits>;
  rateLimiter?: RateLimiter;
  rateLimitPolicies?: Partial<WorkRateLimitPolicies>;
};

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();
  const authDependencies = options.auth ?? createDefaultAuthDependencies();
  const meDependencies = options.me ?? createDefaultMeDependencies();
  const organizationDirectory =
    options.organizationDirectory ?? new PostgresOrganizationDirectoryStore();
  const authLifecycle =
    options.authLifecycle ?? createDefaultAuthLifecycle(authDependencies);
  const corsOrigins = options.corsOrigins ?? env.cors.allowedOrigins;
  const boards = options.boards ?? new PostgresBoardStore();
  const notifications =
    options.notifications ?? new PostgresNotificationStore();
  const tickets = options.tickets ?? new PostgresTicketStore();
  const attendance = options.attendance ?? new PostgresAttendanceStore();
  const chat = options.chat ?? new PostgresChatStore();
  const content = options.content ?? new PostgresContentStore();
  const leave = new PostgresLeaveStore();
  const documents = new PostgresDocumentsStore();
  const branding = new PostgresBrandingStore();
  const duty = new PostgresDutyStore();
  const media = new PostgresMediaStore();
  const stock = new PostgresStockStore();
  const fleet = new PostgresFleetStore();
  const meetingsStore = new PostgresMeetingsStore();
  const obligations = new PostgresObligationsStore();
  const locationPlanner = new PostgresLocationPlannerStore();
  const tourism = new PostgresTourismStore();
  const social = new PostgresSocialStore();
  const security = new PostgresSecurityStore();
  const university = new PostgresUniversityStore();
  const itWorkspace = new PostgresItStore();
  const aiWorkspace = new PostgresAiStore();
  const files =
    options.files ??
    (env.minio.accessKey && env.minio.secretKey
      ? new MinioFileStorage()
      : new MemoryFileStorage());
  const meWithFiles: MeRouteDependencies = {
    ...meDependencies,
    files: meDependencies.files ?? files,
  };
  const trustedProxyIps = options.trustedProxyIps ?? env.trustedProxyIps;
  const limits: HttpLimits = {
    maxRequestBodyBytes:
      options.limits?.maxRequestBodyBytes ?? env.limits.maxRequestBodyBytes,
    maxAttachmentBytes:
      options.limits?.maxAttachmentBytes ?? env.limits.maxAttachmentBytes,
    maxContentStudioUploadBytes:
      options.limits?.maxContentStudioUploadBytes ??
      env.limits.maxContentStudioUploadBytes,
  };
  const rateLimiter = options.rateLimiter ?? authLifecycle.rateLimiter;
  const rateLimitPolicies: WorkRateLimitPolicies = {
    ...env.rateLimits,
    ...options.rateLimitPolicies,
  };

  app.use('*', securityHeadersMiddleware(env.appEnv));
  app.use('*', corsMiddleware(corsOrigins));
  app.use('*', requestContext);
  app.use('*', clientIpMiddleware(trustedProxyIps));
  app.use('*', bodyLimitMiddleware(limits.maxRequestBodyBytes));
  app.use('*', csrfMiddleware(corsOrigins));
  app.use('*', async (c, next) => {
    c.set('rateLimiter', rateLimiter);
    c.set('rateLimitPolicies', rateLimitPolicies);
    c.set('limits', limits);
    await next();
  });
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
  const apiAuth = createAuthMiddleware(authDependencies);
  api.use('*', async (c, next) => {
    // Native media requests carry only the short-lived capability query value.
    // Hono retains the /api mount prefix in c.req.path.
    if (c.req.method === 'GET' && c.req.path === '/api/content-studio/media') {
      return next();
    }
    return apiAuth(c, next);
  });
  api.route('/me', createMeRoutes(meWithFiles));
  api.route('/organization', createOrganizationRoutes({ store: organizationDirectory }));
  api.route(
    '/organization',
    createBrandingRoutes({ store: branding, files }),
  );
  api.route('/offices', createOfficeRoutes({ store: organizationDirectory }));
  api.route('/roles', createRoleRoutes({ store: organizationDirectory }));
  api.route('/duty-roster', createDutyRoutes({ store: duty }));
  api.route(
    '/media',
    createMediaRoutes({ store: media, notifications }),
  );
  const ecosystem = { store: boards, files, notifications };
  api.route('/boards', createBoardCardRoutes({ store: boards }));
  api.route('/boards', createBoardColumnRoutes({ store: boards }));
  api.route('/boards', createBoardRoutes({ store: boards }));
  api.route('/columns', createColumnRoutes({ store: boards }));
  api.route('/cards', createCardNestedRoutes(ecosystem));
  api.route('/cards', createCardRoutes({ store: boards }));
  api.route('/comments', createCommentRoutes(ecosystem));
  api.route('/labels', createLabelRoutes(ecosystem));
  api.route('/submissions', createSubmissionRoutes(ecosystem));
  api.route('/attachments', createAttachmentRoutes(ecosystem));
  api.route('/time-entries', createTimeEntryRoutes(ecosystem));
  api.route('/checklists', createChecklistRoutes(ecosystem));
  api.route('/checklist-items', createChecklistItemRoutes(ecosystem));
  api.route('/notifications', createNotificationRoutes({ store: notifications }));
  api.route('/tickets', createTicketRoutes({ store: tickets, files }));
  api.route('/attendance', createAttendanceRoutes({ store: attendance }));
  api.route(
    '/chat',
    createChatRoutes({
      store: chat,
      files,
      directory: organizationDirectory,
    }),
  );
  api.route(
    '/content-studio',
    createContentStudioRoutes({
      store: content,
      files,
      directory: organizationDirectory,
    }),
  );
  api.route('/kodex', createKodexRoutes({ files, chat }));
  api.route('/leave', createLeaveRoutes({ store: leave }));
  api.route(
    '/documents',
    createDocumentsRoutes({
      store: documents,
      files,
      notifications,
    }),
  );
  api.route('/stock', createStockRoutes({ store: stock, files }));
  api.route('/fleet', createFleetRoutes({ store: fleet }));
  api.route('/meetings', createMeetingsRoutes({ store: meetingsStore }));
  api.route('/obligations', createObligationsRoutes({ store: obligations }));
  api.route(
    '/location-planner',
    createLocationPlannerRoutes({ store: locationPlanner }),
  );
  api.route('/tourism', createTourismRoutes({ store: tourism }));
  api.route('/social', createSocialRoutes({ store: social }));
  api.route('/security', createSecurityRoutes({ store: security }));
  api.route('/university', createUniversityRoutes({ store: university }));
  api.route(
    '/it',
    createItRoutes({
      store: itWorkspace,
      passwords: authLifecycle.passwords,
    }),
  );
  api.route('/ai', createAiRoutes({ store: aiWorkspace, files }));
  api.route('/automation', createAutomationRoutes({ store: aiWorkspace }));


  app.route(
    '/api/content-studio/portal',
    createContentPortalRoutes({
      store: content,
      files,
    }),
  );
  app.route(
    '/api/content-studio/preview',
    createContentPreviewRoutes({
      store: content,
      files,
    }),
  );

  app.route(
    '/api/tickets/portal',
    createTicketPortalRoutes({
      store: tickets,
      files,
    }),
  );

  app.route(
    '/api/public/organization',
    createPublicBrandingRoutes({ store: branding }),
  );

  app.route(
    '/api/meetings/guest',
    createPublicMeetingGuestRoutes({ store: meetingsStore }),
  );

  app.route(
    '/api/security/ingest',
    createSecurityIngestRoutes({ store: security }),
  );
  app.route(
    '/api/security/decoy',
    createSecurityDecoyRoutes({ store: security }),
  );
  app.route('/api', api);


  app.route(
    '/ws/chat',
    createChatWebSocketRoutes({
      auth: authDependencies,
      store: chat,
    }),
  );

  return app;
}
