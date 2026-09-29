import { Hono } from 'hono';

import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../http/errors.js';
import { readJson } from '../work/http.js';
import { importEziTrackDailyReport } from '../fleet/ezitrack-importer.js';
import type { PostgresSecurityStore } from '../security/postgres-store.js';

export type FleetIngestRouteDependencies = {
  security: PostgresSecurityStore;
};

export function createFleetIngestRoutes(
  dependencies: FleetIngestRouteDependencies,
) {
  const routes = new Hono();

  routes.post('/ezitrack', async (c) => {
    /*
     * Never accept machine credentials in the URL. This mirrors the
     * existing Security ingest endpoint and avoids leaking tokens through
     * URLs, proxies and logs.
     */
    if (c.req.query('token') || c.req.query('access_token')) {
      throw new UnauthorizedError();
    }

    const authHeader = c.req.header('authorization') ?? '';
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const headerToken = c.req.header('x-kode-ingest-token')?.trim();

    if (bearer && !bearer.startsWith('kdesk_')) {
      throw new UnauthorizedError();
    }

    if (!bearer && !headerToken) {
      throw new UnauthorizedError();
    }

    const rawToken = bearer || headerToken || '';

    if (!rawToken) {
      throw new ValidationError(
        'Ingest token required (Bearer or X-Kode-Ingest-Token).',
      );
    }

    const resolved = await dependencies.security.resolveIngestToken(rawToken);

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

    if (!Array.isArray(body.records)) {
      throw new ValidationError('records must be an array.');
    }

    /*
     * The ingest token owns the organization identity.
     * organizationId supplied by n8n is deliberately not trusted.
     */
    if (
      typeof body.organizationId === 'string' &&
      body.organizationId.trim() &&
      body.organizationId.trim() !== String(resolved.organization_id)
    ) {
      throw new ForbiddenError(
        'ORGANIZATION_MISMATCH',
        'Payload organization does not match ingest credential.',
      );
    }

    const result = await importEziTrackDailyReport(
      String(resolved.organization_id),
      {
        source:
          typeof body.source === 'string'
            ? body.source
            : 'ezitrack_email',

        fileName:
          typeof body.fileName === 'string'
            ? body.fileName
            : null,

        emailSubject:
          typeof body.emailSubject === 'string'
            ? body.emailSubject
            : null,

        emailFrom:
          typeof body.emailFrom === 'string'
            ? body.emailFrom
            : null,

        receivedAt:
          typeof body.receivedAt === 'string'
            ? body.receivedAt
            : null,

        messageId:
          typeof body.messageId === 'string'
            ? body.messageId
            : null,

        records: body.records as Record<string, unknown>[],
      },
    );

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
      result.duplicate ? 200 : 201,
    );
  });

  return routes;
}
