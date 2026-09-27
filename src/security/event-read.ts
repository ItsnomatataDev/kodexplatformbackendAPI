import { db } from '../db/pool.js';
import { keysetPredicate, pageOf, type ListQuery } from '../db/list-bounds.js';
import { ValidationError } from '../http/errors.js';

const EVENT_LIST_DEFAULT = 50;
const EVENT_LIST_MAX = 200;
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const ALLOWED_QUERY = new Set([
  'project_id',
  'integration_id',
  'event_type',
  'severity',
  'created_from',
  'created_to',
  'limit',
  'before',
  'beforeId',
]);

export type SecurityEventListQuery = ListQuery & {
  projectId?: string;
  integrationId?: string;
  eventType?: string;
  severity?: string;
  createdFrom?: string;
  createdTo?: string;
};

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? null : String(value);
}

export function readSecurityEventQuery(searchParams: URLSearchParams): SecurityEventListQuery {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY.has(key)) {
      throw new ValidationError(`${key} is not a supported event filter.`, { field: key });
    }
  }
  const limitRaw = searchParams.get('limit');
  let limit = EVENT_LIST_DEFAULT;
  if (limitRaw != null && limitRaw !== '') {
    if (!/^[1-9]\d*$/.test(limitRaw)) {
      throw new ValidationError('limit must be an integer from 1 to 200.', { field: 'limit' });
    }
    limit = Number(limitRaw);
    if (limit > EVENT_LIST_MAX) {
      throw new ValidationError('limit must be an integer from 1 to 200.', { field: 'limit' });
    }
  }
  const before = searchParams.get('before')?.trim() || undefined;
  const beforeId = searchParams.get('beforeId')?.trim() || undefined;
  if (Boolean(before) !== Boolean(beforeId)) {
    throw new ValidationError(
      'before and beforeId must be provided together as a timestamp and id.',
    );
  }
  if (before && Number.isNaN(Date.parse(before))) {
    throw new ValidationError('before must be an ISO 8601 timestamp.', { field: 'before' });
  }
  if (beforeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(beforeId)) {
    throw new ValidationError('beforeId must be a UUID.', { field: 'beforeId' });
  }
  return {
    limit,
    before,
    beforeId,
    projectId: readUuidFilter(searchParams.get('project_id'), 'project_id'),
    integrationId: readUuidFilter(searchParams.get('integration_id'), 'integration_id'),
    eventType: readEventTypeFilter(searchParams.get('event_type')),
    severity: readSeverityFilter(searchParams.get('severity')),
    createdFrom: readTimestampFilter(searchParams.get('created_from'), 'created_from'),
    createdTo: readTimestampFilter(searchParams.get('created_to'), 'created_to'),
  };
}

function readUuidFilter(value: string | null, field: string) {
  if (value == null || value === '') return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${field} must be a UUID.`, { field });
  }
  return value;
}

function readEventTypeFilter(value: string | null) {
  if (value == null || value === '') return undefined;
  if (value.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new ValidationError('event_type is invalid.', { field: 'event_type' });
  }
  return value;
}

function readSeverityFilter(value: string | null) {
  if (value == null || value === '') return undefined;
  if (!SEVERITIES.has(value)) {
    throw new ValidationError('severity is not an allowed value.', { field: 'severity' });
  }
  return value;
}

function readTimestampFilter(value: string | null, field: string) {
  if (value == null || value === '') return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO 8601 timestamp.`, { field });
  }
  return new Date(value).toISOString();
}

export async function listSecurityEvents(
  organizationId: string,
  query: SecurityEventListQuery,
) {
  if (
    query.createdFrom &&
    query.createdTo &&
    Date.parse(query.createdFrom) > Date.parse(query.createdTo)
  ) {
    throw new ValidationError('created_from must be before or equal to created_to.', {
      field: 'created_from',
    });
  }
  const params: unknown[] = [organizationId];
  const filters = ['organization_id = $1'];
  if (query.projectId) {
    params.push(query.projectId);
    filters.push(`project_id = $${params.length}`);
  }
  if (query.integrationId) {
    params.push(query.integrationId);
    filters.push(`integration_id = $${params.length}`);
  }
  if (query.eventType) {
    params.push(query.eventType);
    filters.push(`event_type = $${params.length}`);
  }
  if (query.severity) {
    params.push(query.severity);
    filters.push(`severity = $${params.length}`);
  }
  if (query.createdFrom) {
    params.push(query.createdFrom);
    filters.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (query.createdTo) {
    params.push(query.createdTo);
    filters.push(`created_at <= $${params.length}::timestamptz`);
  }
  const cursor = keysetPredicate(
    params,
    { at: query.before, id: query.beforeId },
    'created_at',
    'id',
  );
  params.push(query.limit + 1);
  const result = await db.query(
    `SELECT id, project_id, integration_id, external_event_id, event_type,
            severity, metadata, created_at
     FROM security.events
     WHERE ${filters.join(' AND ')}
       ${cursor}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const paged = pageOf(
    result.rows.map((row) => ({
      id: String(row.id),
      project_id: row.project_id == null ? null : String(row.project_id),
      integration_id: row.integration_id == null ? null : String(row.integration_id),
      external_event_id:
        row.external_event_id == null ? null : String(row.external_event_id),
      event_type: String(row.event_type),
      severity: String(row.severity),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      created_at: iso(row.created_at),
    })),
    query.limit,
  );
  return { events: paged.rows, hasMore: paged.hasMore };
}
