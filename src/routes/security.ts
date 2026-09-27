import { Hono } from 'hono';
import type { Context } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { enforceRateLimit, type RateLimiter } from '../auth/rate-limit.js';
import { listOffset } from '../db/list-bounds.js';
import { ForbiddenError, ServiceUnavailableError, UnauthorizedError, ValidationError } from '../http/errors.js';
import { readListQuery } from '../http/list-query.js';
import { rejectIdentityOverrides, readJson, readOptionalInteger, readRequiredText, requireUuidValue } from '../work/http.js';
import {
  readAssetStatus,
  readAssetType,
  readCredentialRef,
  readCriticality,
  readEnvironment,
  readIntegrationType,
  readProjectStatus,
  readSlug,
  rejectSecretFields,
} from '../security/foundation-input.js';
import { env } from '../config/env.js';
import {
  INTEGRATION_CREDENTIAL_SCOPE,
  integrationCredentialRateLimitKey,
  issueIntegrationCredential,
  listIntegrationCredentials,
  parseIntegrationCredential,
  revokeIntegrationCredential,
  verifyIntegrationCredential,
} from '../security/integration-credentials.js';
import {
  insertIntegrationEvent,
  normalizeIntegrationEvent,
} from '../security/integration-ingest.js';
import { listSecurityEvents, readSecurityEventQuery } from '../security/event-read.js';
import {
  createSecurityAsset,
  createSecurityIntegration,
  createSecurityProject,
  getSecurityProject,
  listProjectAssets,
  listProjectIntegrations,
  retireSecurityAsset,
  retireSecurityProject,
  revokeSecurityIntegration,
  updateSecurityAsset,
  updateSecurityProject,
} from '../security/foundation-store.js';
import { isSecurityStaff, requireProductOrg } from '../products/staff.js';
import { requireSecurityPermission } from '../security/permissions.js';
import { recordSecurityEvent } from '../security/recorder.js';
import type { PostgresSecurityStore } from '../security/postgres-store.js';

export type SecurityRouteDependencies = { store: PostgresSecurityStore };

function authorize(auth: ReturnType<typeof getAuth>) {
  const organizationId = requireProductOrg(auth);
  if (!isSecurityStaff(auth)) {
    throw new ForbiddenError('SECURITY_ADMIN_REQUIRED', 'Security admin access required.');
  }
  return organizationId;
}

function isPrivateIp(ip: string) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc00:|fd)/.test(ip);
}

export function createSecurityIngestRoutes(
  dependencies: SecurityRouteDependencies,
) {
  const routes = new Hono();

  routes.post('/', async (c) => {
    if (c.req.query('token') || c.req.query('access_token')) {
      throw new UnauthorizedError();
    }
    const authHeader = c.req.header('authorization') ?? '';
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (bearer?.startsWith('kint_')) {
      return ingestIntegrationCredential(c, bearer);
    }
    if (bearer && !bearer.startsWith('kdesk_')) {
      throw new UnauthorizedError();
    }
    if (!bearer && !c.req.header('x-kode-ingest-token')?.trim()) {
      throw new UnauthorizedError();
    }
    const headerToken = c.req.header('x-kode-ingest-token')?.trim();
    const rawToken = bearer || headerToken || '';
    if (!rawToken) {
      throw new ValidationError(
        'Ingest token required (Bearer or X-Kode-Ingest-Token).',
      );
    }
    const resolved = await dependencies.store.resolveIngestToken(rawToken);
    if (!resolved || resolved.status === 'retired') {
      throw new ForbiddenError(
        'INVALID_INGEST_TOKEN',
        'Invalid or revoked ingest token.',
      );
    }
    if (resolved.status === 'paused') {
      throw new ForbiddenError(
        'SYSTEM_PAUSED',
        'Monitored system ingest is paused.',
      );
    }

    const body = await readJson(c);
    const heartbeat = Boolean(body.heartbeat);
    const eventTypeRaw = body.event_type ?? body.eventType;
    if (
      !heartbeat &&
      (eventTypeRaw == null || String(eventTypeRaw).trim() === '')
    ) {
      throw new ValidationError(
        'event_type is required unless heartbeat=true.',
      );
    }

    const result = await dependencies.store.ingestExternalEvent({
      organizationId: resolved.organization_id as string,
      systemId: resolved.system_id as string,
      tokenId: resolved.token_id as string,
      input: {
        eventType: String(eventTypeRaw ?? 'heartbeat').trim(),
        severity:
          typeof body.severity === 'string' ? body.severity : 'medium',
        riskScore:
          body.risk_score != null || body.riskScore != null
            ? Number(body.risk_score ?? body.riskScore)
            : 0,
        successful: Boolean(body.successful),
        ipAddress:
          typeof body.ip_address === 'string'
            ? body.ip_address
            : typeof body.ipAddress === 'string'
              ? body.ipAddress
              : null,
        endpoint: typeof body.endpoint === 'string' ? body.endpoint : null,
        attackCategory:
          typeof body.attack_category === 'string'
            ? body.attack_category
            : typeof body.attackCategory === 'string'
              ? body.attackCategory
              : null,
        externalEventId:
          typeof body.external_event_id === 'string'
            ? body.external_event_id
            : typeof body.externalEventId === 'string'
              ? body.externalEventId
              : null,
        title: typeof body.title === 'string' ? body.title : null,
        description:
          typeof body.description === 'string' ? body.description : null,
        metadata:
          body.metadata && typeof body.metadata === 'object'
            ? (body.metadata as Record<string, unknown>)
            : {},
        healthStatus:
          typeof body.health_status === 'string'
            ? body.health_status
            : typeof body.healthStatus === 'string'
              ? body.healthStatus
              : null,
        heartbeat,
      },
    });

    return c.json(
      {
        ok: true,
        system: {
          id: resolved.system_id,
          slug: resolved.slug,
          name: resolved.name,
        },
        ...result,
      },
      201,
    );
  });

  return routes;
}

/** Public decoy handler — records honeypot trips, never returns real data. */
export function createSecurityDecoyRoutes(
  dependencies: SecurityRouteDependencies,
) {
  const routes = new Hono();

  routes.all('/:slug', async (c) => {
    const slug = c.req.param('slug')?.trim();
    if (!slug) {
      return c.json({ error: 'Not found' }, 404);
    }
    const path = `/api/security/decoy/${slug}`;
    const target = await dependencies.store.findEnabledHoneypotBySlug(slug);
    if (target) {
      await recordSecurityEvent({
        organizationId: String(target.organization_id),
        eventType: 'HONEYPOT_INTERACTION',
        severity:
          (target.severity as 'info' | 'low' | 'medium' | 'high' | 'critical') ??
          'high',
        riskScore: 90,
        successful: false,
        ipAddress:
          (c.get('clientIp') as string | undefined) ??
          c.req.header('x-forwarded-for') ??
          null,
        userAgent: c.req.header('user-agent') ?? null,
        requestMethod: c.req.method,
        endpoint: path,
        httpStatus: Number(target.response_status ?? 404),
        attackCategory: 'honeypot',
        projectId: (target.project_id as string | null) ?? null,
        assetId: (target.asset_id as string | null) ?? null,
        metadata: {
          honeypot_id: target.id,
          honeypot_slug: target.slug,
        },
      });
      return c.text(String(target.response_body ?? ''), {
        status: Number(target.response_status ?? 404) as 404,
      });
    }
    return c.json({ error: 'Not found' }, 404);
  });

  return routes;
}

async function ingestIntegrationCredential(c: Context, credential: string) {
  const parsed = parseIntegrationCredential(credential);
  const verified = parsed ? await verifyIntegrationCredential(credential) : { ok: false as const };
  if (!parsed || !verified.ok) {
    throw new UnauthorizedError();
  }
  if (verified.context.scope !== INTEGRATION_CREDENTIAL_SCOPE) {
    throw new ForbiddenError(
      'INTEGRATION_SCOPE_REQUIRED',
      'Integration credential cannot submit events.',
    );
  }
  const limiter = c.get('rateLimiter') as RateLimiter | undefined;
  if (!limiter) {
    throw new ServiceUnavailableError(
      'RATE_LIMIT_UNAVAILABLE',
      'Rate limiting is temporarily unavailable.',
    );
  }
  await enforceRateLimit(
    limiter,
    integrationCredentialRateLimitKey(parsed.keyId),
    env.rateLimits.mutation.limit,
    env.rateLimits.mutation.windowSeconds,
  );
  const body = await readJson(c);
  const normalized = normalizeIntegrationEvent(body, verified.context);
  const stored = await insertIntegrationEvent(normalized);
  return c.json({ accepted: true, event_id: stored.eventId }, 201);
}

export function createSecurityRoutes(dependencies: SecurityRouteDependencies) {
  const routes = new Hono();

  routes.get('/control-center', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    return c.json(await dependencies.store.controlCenterSummary(organizationId));
  });

  routes.get('/investigations/ip/:ip', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.investigate');
    const ip = decodeURIComponent(c.req.param('ip') ?? '').trim();
    if (!ip) throw new ValidationError('ip is required.');
    return c.json(await dependencies.store.investigateByIp(organizationId, ip));
  });

  routes.get('/events', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    const query = readSecurityEventQuery(new URL(c.req.url).searchParams);
    return c.json(await listSecurityEvents(organizationId, query));
  });

  routes.get('/projects', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    const page = readListQuery(c);
    const projects = await dependencies.store.listProjects(organizationId, {
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });
    return c.json({ projects: projects.projects, hasMore: projects.hasMore });
  });

  routes.post('/projects', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_assets');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const project = await createSecurityProject(organizationId, auth.actor.userId, {
      slug: readSlug(body.slug),
      name: readRequiredText(body.name, 'name', 200),
      description:
        typeof body.description === 'string'
          ? readRequiredText(body.description, 'description', 2000)
          : null,
      criticality: readCriticality(body.criticality),
      environment: readEnvironment(body.environment),
    });
    return c.json({ project }, 201);
  });

  routes.get('/projects/:projectId', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    return c.json({
      project: await getSecurityProject(organizationId, projectId),
    });
  });

  routes.patch('/projects/:projectId', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_assets');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const project = await updateSecurityProject(
      organizationId,
      auth.actor.userId,
      projectId,
      {
        name:
          body.name === undefined
            ? undefined
            : readRequiredText(body.name, 'name', 200),
        description:
          body.description === undefined
            ? undefined
            : body.description === null
              ? null
              : readRequiredText(body.description, 'description', 2000),
        status:
          body.status === undefined ? undefined : readProjectStatus(body.status),
        criticality:
          body.criticality === undefined
            ? undefined
            : readCriticality(body.criticality),
        environment:
          body.environment === undefined
            ? undefined
            : readEnvironment(body.environment),
      },
    );
    return c.json({ project });
  });

  routes.delete('/projects/:projectId', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_assets');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const project = await retireSecurityProject(
      organizationId,
      auth.actor.userId,
      projectId,
    );
    return c.json({ project });
  });

  routes.get('/projects/:projectId/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const page = readListQuery(c);
    const assets = await listProjectAssets(organizationId, projectId, {
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });
    return c.json(assets);
  });

  routes.post('/projects/:projectId/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_assets');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const asset = await createSecurityAsset(organizationId, auth.actor.userId, {
      projectId,
      slug: readSlug(body.slug),
      name: readRequiredText(body.name, 'name', 200),
      assetType: readAssetType(body.asset_type ?? body.assetType),
      environment: readEnvironment(body.environment),
      hostname:
        typeof body.hostname === 'string'
          ? readRequiredText(body.hostname, 'hostname', 255)
          : null,
      criticality: readCriticality(body.criticality),
    });
    return c.json({ asset }, 201);
  });

  routes.patch('/projects/:projectId/assets/:assetId', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_assets');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const asset = await updateSecurityAsset(
      organizationId,
      auth.actor.userId,
      projectId,
      assetId,
      {
        name:
          body.name === undefined
            ? undefined
            : readRequiredText(body.name, 'name', 200),
        assetType:
          body.asset_type === undefined && body.assetType === undefined
            ? undefined
            : readAssetType(body.asset_type ?? body.assetType),
        environment:
          body.environment === undefined
            ? undefined
            : readEnvironment(body.environment),
        hostname:
          body.hostname === undefined
            ? undefined
            : body.hostname === null
              ? null
              : readRequiredText(body.hostname, 'hostname', 255),
        criticality:
          body.criticality === undefined
            ? undefined
            : readCriticality(body.criticality),
        status: body.status === undefined ? undefined : readAssetStatus(body.status),
      },
    );
    return c.json({ asset });
  });

  routes.delete('/projects/:projectId/assets/:assetId', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_assets');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const asset = await retireSecurityAsset(
      organizationId,
      auth.actor.userId,
      projectId,
      assetId,
    );
    return c.json({ asset });
  });

  routes.get('/projects/:projectId/integrations', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const page = readListQuery(c);
    const integrations = await listProjectIntegrations(organizationId, projectId, {
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });
    return c.json(integrations);
  });

  routes.post('/projects/:projectId/integrations', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(
      auth,
      'security.manage_configuration',
    );
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    rejectSecretFields(body);
    const integration = await createSecurityIntegration(
      organizationId,
      auth.actor.userId,
      {
        projectId,
        slug: readSlug(body.slug),
        name: readRequiredText(body.name, 'name', 200),
        integrationType: readIntegrationType(
          body.integration_type ?? body.integrationType,
        ),
        credentialRef: readCredentialRef(body.credential_ref ?? body.credentialRef),
      },
    );
    return c.json({ integration }, 201);
  });

  routes.post('/projects/:projectId/integrations/:integrationId/revoke', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(
      auth,
      'security.manage_configuration',
    );
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const integrationId = requireUuidValue(
      c.req.param('integrationId'),
      'integrationId',
    );
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    rejectSecretFields(body);
    const integration = await revokeSecurityIntegration(
      organizationId,
      auth.actor.userId,
      projectId,
      integrationId,
      readRequiredText(body.reason, 'reason', 500),
    );
    return c.json({ integration });
  });

  routes.get('/projects/:projectId/integrations/:integrationId/credentials', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const integrationId = requireUuidValue(c.req.param('integrationId'), 'integrationId');
    const page = readListQuery(c);
    return c.json(
      await listIntegrationCredentials(organizationId, projectId, integrationId, {
        limit: page.limit,
        offset: listOffset(Number(c.req.query('offset'))),
      }),
    );
  });

  routes.post('/projects/:projectId/integrations/:integrationId/credentials', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_configuration');
    const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
    const integrationId = requireUuidValue(c.req.param('integrationId'), 'integrationId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    rejectSecretFields(body);
    const ttlDays = readOptionalInteger(body.expires_in_days, 'expires_in_days');
    if (ttlDays !== undefined && (ttlDays < 1 || ttlDays > 90)) {
      throw new ValidationError('expires_in_days must be between 1 and 90.', {
        field: 'expires_in_days',
      });
    }
    const issued = await issueIntegrationCredential(
      organizationId,
      auth.actor.userId,
      projectId,
      integrationId,
      ttlDays,
    );
    return c.json(issued, 201);
  });

  routes.post(
    '/projects/:projectId/integrations/:integrationId/credentials/:credentialId/revoke',
    async (c) => {
      const auth = getAuth(c);
      const organizationId = requireSecurityPermission(
        auth,
        'security.manage_configuration',
      );
      const projectId = requireUuidValue(c.req.param('projectId'), 'projectId');
      const integrationId = requireUuidValue(
        c.req.param('integrationId'),
        'integrationId',
      );
      const credentialId = requireUuidValue(
        c.req.param('credentialId'),
        'credentialId',
      );
      const body = await readJson(c);
      rejectIdentityOverrides(auth, c, body);
      rejectSecretFields(body);
      const credential = await revokeIntegrationCredential(
        organizationId,
        auth.actor.userId,
        projectId,
        integrationId,
        credentialId,
        readRequiredText(body.reason, 'reason', 500),
      );
      return c.json({ credential });
    },
  );

  routes.get('/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    const projectId = c.req.query('projectId') ?? c.req.query('project_id') ?? null;
    const page = readListQuery(c);
    const assets = await dependencies.store.listAssets(
      organizationId,
      projectId && projectId.trim() ? projectId.trim() : null,
      {
        limit: page.limit,
        offset: listOffset(Number(c.req.query('offset'))),
      },
    );
    return c.json({ assets: assets.assets, hasMore: assets.hasMore });
  });

  routes.post('/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.manage_assets');
    const body = await readJson(c);
    const slug = readRequiredText(body.slug, 'slug', 80)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-');
    const name = readRequiredText(body.name, 'name', 200);
    const asset = await dependencies.store.createAsset(
      organizationId,
      auth.actor.userId,
      {
        slug,
        name,
        assetType:
          typeof body.asset_type === 'string'
            ? body.asset_type
            : typeof body.assetType === 'string'
              ? body.assetType
              : 'service',
        environment:
          typeof body.environment === 'string' ? body.environment : 'production',
        hostname:
          typeof body.hostname === 'string'
            ? body.hostname
            : typeof body.base_url === 'string'
              ? body.base_url
              : null,
        projectId:
          typeof body.project_id === 'string'
            ? body.project_id
            : typeof body.projectId === 'string'
              ? body.projectId
              : null,
        criticality:
          typeof body.criticality === 'string' ? body.criticality : 'medium',
      },
    );
    return c.json({ asset }, 201);
  });

  routes.get('/incidents/:incidentId', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.investigate');
    const incidentId = requireUuidValue(c.req.param('incidentId'), 'incidentId');
    return c.json(
      await dependencies.store.getIncidentDetail(organizationId, incidentId),
    );
  });

  routes.get('/audit', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.audit');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 100;
    return c.json({
      entries: await dependencies.store.listAuditLog(organizationId, limit),
    });
  });

  routes.get('/honeypots', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    return c.json({
      honeypots: await dependencies.store.listHoneypots(organizationId),
    });
  });

  routes.post('/honeypots', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(
      auth,
      'security.manage_honeypots',
    );
    const body = await readJson(c);
    const slug = readRequiredText(body.slug, 'slug', 80)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-');
    const name = readRequiredText(body.name, 'name', 200);
    const endpointPath = readRequiredText(
      body.endpoint_path ?? body.endpointPath,
      'endpoint_path',
      200,
    );
    const honeypot = await dependencies.store.createHoneypot(
      organizationId,
      auth.actor.userId,
      {
        slug,
        name,
        endpointPath,
        severity: typeof body.severity === 'string' ? body.severity : 'high',
        enabled: body.enabled === true,
        projectId:
          typeof body.project_id === 'string'
            ? body.project_id
            : typeof body.projectId === 'string'
              ? body.projectId
              : null,
        assetId:
          typeof body.asset_id === 'string'
            ? body.asset_id
            : typeof body.assetId === 'string'
              ? body.assetId
              : null,
      },
    );
    return c.json({ honeypot }, 201);
  });

  routes.get('/rules', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.view');
    return c.json({
      rules: await dependencies.store.listDetectionRules(organizationId),
    });
  });

  routes.get('/summary', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json(await dependencies.store.summary(organizationId));
  });

  routes.get('/events', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const systemId = c.req.query('systemId') ?? c.req.query('system_id') ?? null;
    return c.json({
      events: await dependencies.store.listEvents(organizationId, {
        systemId: systemId && systemId.trim() ? systemId.trim() : null,
      }),
    });
  });

  routes.get('/alerts', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const systemId = c.req.query('systemId') ?? c.req.query('system_id') ?? null;
    return c.json({
      alerts: await dependencies.store.listAlerts(organizationId, {
        systemId: systemId && systemId.trim() ? systemId.trim() : null,
      }),
    });
  });

  routes.get('/incidents', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const systemId = c.req.query('systemId') ?? c.req.query('system_id') ?? null;
    return c.json({
      incidents: await dependencies.store.listIncidents(organizationId, {
        systemId: systemId && systemId.trim() ? systemId.trim() : null,
      }),
    });
  });

  routes.post('/incidents', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    body.title = readRequiredText(body.title, 'title', 200);
    return c.json({
      incident: await dependencies.store.createIncident(organizationId, auth.actor.userId, body),
    }, 201);
  });

  routes.patch('/incidents/:incidentId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const incidentId = requireUuidValue(c.req.param('incidentId'), 'incidentId');
    const body = await readJson(c);
    return c.json({
      incident: await dependencies.store.updateIncident(organizationId, incidentId, body, auth.actor.userId),
    });
  });

  routes.get('/blocklist', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ blocklist: await dependencies.store.listBlocklist(organizationId) });
  });

  routes.get('/sessions', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ sessions: await dependencies.store.listSessions(organizationId) });
  });

  routes.get('/devices', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ devices: await dependencies.store.listDevices(organizationId) });
  });

  routes.get('/login-verifications', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({
      verifications: await dependencies.store.listLoginVerifications(organizationId),
    });
  });

  routes.get('/high-risk-ips', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ ips: await dependencies.store.listHighRiskIps(organizationId) });
  });

  routes.get('/high-risk-users', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const sinceParam = c.req.query('since');
    const daysParam = c.req.query('days');
    const limitParam = c.req.query('limit');
    const days = daysParam ? Number(daysParam) : null;
    let since: string | undefined;
    if (sinceParam && sinceParam.trim()) {
      since = sinceParam.trim();
      if (Number.isNaN(Date.parse(since))) {
        throw new ValidationError('since must be a valid ISO date.');
      }
    } else if (days != null && Number.isFinite(days) && days > 0) {
      since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    }
    const limit =
      limitParam && Number.isFinite(Number(limitParam))
        ? Number(limitParam)
        : 20;
    return c.json({
      users: await dependencies.store.listHighRiskUsers(organizationId, {
        since,
        limit,
      }),
    });
  });

  routes.post('/enrich-ip', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const ip = String(body.ip_address ?? body.ipAddress ?? '').trim();
    if (!ip) throw new ValidationError('ip_address is required.');
    if (isPrivateIp(ip)) {
      return c.json({ skipped: true, reason: 'private_ip' });
    }

    // Prefer caller-supplied enrichment; otherwise attempt public IP geolocation.
    let enrichment = (body.enrichment as Record<string, unknown> | undefined) ?? {};
    if (!Object.keys(enrichment).length) {
      try {
        const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const payload = (await response.json()) as Record<string, unknown>;
          enrichment = {
            country: payload.country_name ?? payload.country ?? null,
            city: payload.city ?? null,
            region: payload.region ?? null,
            latitude: payload.latitude ?? null,
            longitude: payload.longitude ?? null,
            timezone: payload.timezone ?? null,
            isp: payload.org ?? null,
            asn: payload.asn ?? null,
          };
        }
      } catch {
        // Keep empty enrichment if provider is unavailable.
      }
    }

    const row = await dependencies.store.enrichIp(organizationId, ip, enrichment);
    return c.json({ ip: row });
  });

  routes.post('/blocklist', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.contain');
    const body = await readJson(c);
    const ip = String(body.ip_address ?? body.ipAddress ?? body.target_value ?? '').trim();
    const reason = readRequiredText(body.reason, 'reason', 500);
    if (!ip) throw new ValidationError('ip_address is required.');
    const expiresAt =
      typeof body.expires_at === 'string'
        ? body.expires_at
        : typeof body.expiresAt === 'string'
          ? body.expiresAt
          : null;
    const entry = await dependencies.store.blockIp(
      organizationId,
      auth.actor.userId,
      ip,
      reason,
      expiresAt,
    );
    await dependencies.store.recordContainment(organizationId, auth.actor.userId, {
      actionType: 'block_ip',
      targetType: 'ip',
      targetValue: ip,
      reason,
      resultingState: { blocked: true, expires_at: expiresAt },
    });
    return c.json({ entry }, 201);
  });

  routes.post('/blocklist/unblock', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireSecurityPermission(auth, 'security.contain');
    const body = await readJson(c);
    const ip = String(body.ip_address ?? body.ipAddress ?? body.target_value ?? '').trim();
    if (!ip) throw new ValidationError('ip_address is required.');
    const entry = await dependencies.store.unblockIp(
      organizationId,
      auth.actor.userId,
      ip,
    );
    await dependencies.store.recordContainment(organizationId, auth.actor.userId, {
      actionType: 'unblock_ip',
      targetType: 'ip',
      targetValue: ip,
      reason:
        typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'Unblocked from Security Control Center',
      resultingState: { blocked: false },
    });
    return c.json({ entry });
  });

  routes.post('/alerts/:alertId/resolve', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const alertId = requireUuidValue(c.req.param('alertId'), 'alertId');
    const body = await readJson(c);
    const notes =
      typeof body.notes === 'string' && body.notes.trim()
        ? body.notes.trim()
        : typeof body.resolution_notes === 'string' && body.resolution_notes.trim()
          ? body.resolution_notes.trim()
          : 'Resolved from Security Center';
    const alert = await dependencies.store.resolveAlert(
      organizationId,
      alertId,
      auth.actor.userId,
      notes,
    );
    return c.json({ alert });
  });

  routes.post('/login-verifications/:verificationId/review', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const verificationId = requireUuidValue(
      c.req.param('verificationId'),
      'verificationId',
    );
    const body = await readJson(c);
    const decision = String(body.decision ?? '').trim();
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new ValidationError('decision must be approved or rejected.');
    }
    const notes =
      typeof body.notes === 'string' ? body.notes : String(body.review_notes ?? '');
    const verification = await dependencies.store.reviewLoginVerification(
      organizationId,
      verificationId,
      decision,
      notes,
    );
    return c.json({ verification });
  });

  routes.get('/login-verifications/:verificationId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const verificationId = requireUuidValue(
      c.req.param('verificationId'),
      'verificationId',
    );
    const verification = await dependencies.store.getLoginVerification(
      organizationId,
      verificationId,
    );
    return c.json({ verification });
  });

  routes.post('/login-verifications/:verificationId/location', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const verificationId = requireUuidValue(
      c.req.param('verificationId'),
      'verificationId',
    );
    const body = await readJson(c);
    const granted = body.granted !== false && body.deny !== true;
    const verification = await dependencies.store.updateLoginVerificationLocation(
      organizationId,
      verificationId,
      {
        granted,
        latitude:
          typeof body.latitude === 'number'
            ? body.latitude
            : body.latitude == null
              ? null
              : Number(body.latitude),
        longitude:
          typeof body.longitude === 'number'
            ? body.longitude
            : body.longitude == null
              ? null
              : Number(body.longitude),
        accuracyMeters:
          typeof body.accuracyMeters === 'number'
            ? body.accuracyMeters
            : typeof body.accuracy_meters === 'number'
              ? body.accuracy_meters
              : null,
        status: granted ? 'pending_email_otp' : 'manual_review',
      },
    );
    return c.json({ verification, ok: true });
  });

  routes.post('/events', async (c) => {
    const auth = getAuth(c);
    // Authenticated staff can log events for their org (not only security admins).
    const organizationId = requireProductOrg(auth);
    const body = await readJson(c);
    const eventType = readRequiredText(
      body.event_type ?? body.eventType,
      'event_type',
      120,
    );
    const id = await dependencies.store.logEvent(organizationId, {
      userId: auth.actor.userId,
      sessionId:
        typeof body.session_id === 'string'
          ? body.session_id
          : typeof body.sessionId === 'string'
            ? body.sessionId
            : null,
      systemId:
        typeof body.system_id === 'string'
          ? body.system_id
          : typeof body.systemId === 'string'
            ? body.systemId
            : null,
      eventType,
      severity:
        typeof body.severity === 'string' ? body.severity : 'low',
      riskScore:
        body.risk_score != null || body.riskScore != null
          ? Number(body.risk_score ?? body.riskScore)
          : 0,
      successful: Boolean(body.successful),
      ipAddress:
        typeof body.ip_address === 'string'
          ? body.ip_address
          : typeof body.ipAddress === 'string'
            ? body.ipAddress
            : null,
      country: typeof body.country === 'string' ? body.country : null,
      city: typeof body.city === 'string' ? body.city : null,
      userAgent:
        typeof body.user_agent === 'string'
          ? body.user_agent
          : typeof body.userAgent === 'string'
            ? body.userAgent
            : null,
      browser: typeof body.browser === 'string' ? body.browser : null,
      os: typeof body.os === 'string' ? body.os : null,
      device: typeof body.device === 'string' ? body.device : null,
      requestMethod:
        typeof body.request_method === 'string'
          ? body.request_method
          : typeof body.requestMethod === 'string'
            ? body.requestMethod
            : null,
      endpoint: typeof body.endpoint === 'string' ? body.endpoint : null,
      attackCategory:
        typeof body.attack_category === 'string'
          ? body.attack_category
          : typeof body.attackCategory === 'string'
            ? body.attackCategory
            : null,
      metadata:
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Record<string, unknown>)
          : {},
    });
    return c.json({ id }, 201);
  });

  routes.get('/systems', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({
      systems: await dependencies.store.listMonitoredSystems(organizationId),
    });
  });

  routes.get('/desk', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json(await dependencies.store.deskSummary(organizationId));
  });

  routes.post('/systems', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const body = await readJson(c);
    const name = readRequiredText(body.name, 'name', 120);
    const slug = readRequiredText(body.slug ?? name, 'slug', 80);
    const created = await dependencies.store.createMonitoredSystem(
      organizationId,
      {
        slug,
        name,
        description:
          typeof body.description === 'string' ? body.description : null,
        kind: typeof body.kind === 'string' ? body.kind : 'external',
        environment:
          typeof body.environment === 'string' ? body.environment : 'production',
        baseUrl:
          typeof body.base_url === 'string'
            ? body.base_url
            : typeof body.baseUrl === 'string'
              ? body.baseUrl
              : null,
        metadata:
          body.metadata && typeof body.metadata === 'object'
            ? (body.metadata as Record<string, unknown>)
            : {},
      },
      auth.actor.userId,
    );
    return c.json(created, 201);
  });

  routes.patch('/systems/:systemId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const systemId = requireUuidValue(c.req.param('systemId'), 'systemId');
    const body = await readJson(c);
    return c.json({
      system: await dependencies.store.updateMonitoredSystem(
        organizationId,
        systemId,
        body,
      ),
    });
  });

  routes.post('/systems/:systemId/rotate-token', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const systemId = requireUuidValue(c.req.param('systemId'), 'systemId');
    const minted = await dependencies.store.rotateIngestToken(
      organizationId,
      systemId,
      auth.actor.userId,
    );
    return c.json({
      token: minted.token,
      prefix: minted.prefix,
      ingest_url: '/api/security/ingest',
    });
  });

  routes.post('/location', async (c) => {
    const auth = getAuth(c);
    const organizationId = requireProductOrg(auth);
    const body = await readJson(c);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new ValidationError('latitude and longitude are required.');
    }
    const accuracyMeters =
      body.accuracy_meters == null && body.accuracyMeters == null
        ? null
        : Number(body.accuracy_meters ?? body.accuracyMeters);
    const capturedAt =
      typeof body.captured_at === 'string'
        ? body.captured_at
        : typeof body.capturedAt === 'string'
          ? body.capturedAt
          : new Date().toISOString();
    await dependencies.store.recordPreciseLocation(
      organizationId,
      auth.actor.userId,
      latitude,
      longitude,
      Number.isFinite(accuracyMeters) ? accuracyMeters : null,
      capturedAt,
    );
    return c.json({ ok: true });
  });

  return routes;
}
