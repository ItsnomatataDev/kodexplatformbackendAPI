import { db } from '../db/pool.js';
import { optionalMetadata } from '../http/fields.js';
import { ValidationError } from '../http/errors.js';
import { scrubSecurityMetadata } from './recorder.js';
import type { IntegrationCredentialContext } from './integration-credentials.js';

const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
const BOUNDARY_FIELDS = [
  'organization_id',
  'organizationId',
  'project_id',
  'projectId',
  'integration_id',
  'integrationId',
];
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const BOUNDARY_KEY_SET = new Set<string>(BOUNDARY_FIELDS);

export function assertNoBoundaryOverrides(body: Record<string, unknown>) {
  for (const field of BOUNDARY_FIELDS) {
    if (body[field] !== undefined) {
      throw new ValidationError(
        `${field} is assigned by the integration credential and cannot be supplied.`,
        { field },
      );
    }
  }
}

function rejectReservedBoundaryKeys(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) rejectReservedBoundaryKeys(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (BOUNDARY_KEY_SET.has(key)) {
      throw new ValidationError(
        `${key} is reserved and cannot appear in event metadata.`,
        { field: 'metadata' },
      );
    }
    rejectReservedBoundaryKeys(child);
  }
}

function readEventType(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('event_type is required.', { field: 'event_type' });
  }
  const eventType = value.trim();
  if (eventType.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(eventType)) {
    throw new ValidationError('event_type is invalid.', { field: 'event_type' });
  }
  return eventType;
}

function readSeverity(value: unknown) {
  if (value === undefined || value === null || value === '') return 'low';
  if (typeof value !== 'string' || !SEVERITIES.has(value)) {
    throw new ValidationError('severity is not an allowed value.', { field: 'severity' });
  }
  return value;
}

function readBoundedText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string.`, { field });
  }
  const text = value.trim();
  if (text.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters.`, { field });
  }
  return text;
}

function readOccurredAt(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError('occurred_at must be an ISO 8601 timestamp.', {
      field: 'occurred_at',
    });
  }
  const at = new Date(value).getTime();
  const now = Date.now();
  if (at > now + MAX_FUTURE_MS) {
    throw new ValidationError('occurred_at is too far in the future.', {
      field: 'occurred_at',
    });
  }
  if (at < now - MAX_AGE_MS) {
    throw new ValidationError('occurred_at is too old.', { field: 'occurred_at' });
  }
  return new Date(at).toISOString();
}

export function normalizeIntegrationEvent(
  body: Record<string, unknown>,
  context: IntegrationCredentialContext,
) {
  assertNoBoundaryOverrides(body);
  const eventType = readEventType(body.event_type ?? body.eventType);
  const severity = readSeverity(body.severity);
  const source = readBoundedText(body.source, 'source', 120);
  const message = readBoundedText(body.message, 'message', 500);
  const occurredAt = readOccurredAt(body.occurred_at ?? body.occurredAt);
  const externalEventId = readExternalEventId(body.external_event_id);
  const supplied = optionalMetadata(body.metadata) ?? {};
  rejectReservedBoundaryKeys(supplied);
  const metadata = scrubSecurityMetadata({
    ...supplied,
    ...(source ? { source } : {}),
    ...(message ? { message } : {}),
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
  });
  return {
    organizationId: context.organizationId,
    projectId: context.projectId,
    integrationId: context.integrationId,
    externalEventId,
    eventType,
    severity,
    metadata,
  };
}

function readExternalEventId(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ValidationError('external_event_id is invalid.', {
      field: 'external_event_id',
    });
  }
  if (value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ValidationError('external_event_id is invalid.', {
      field: 'external_event_id',
    });
  }
  return value;
}

export async function insertIntegrationEvent(input: {
  organizationId: string;
  projectId: string;
  integrationId: string;
  externalEventId: string | null;
  eventType: string;
  severity: string;
  metadata: Record<string, unknown>;
}) {
  const inserted = await db.query(
    `INSERT INTO security.events (
       organization_id, project_id, integration_id, external_event_id,
       event_type, severity, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (integration_id, external_event_id)
       WHERE integration_id IS NOT NULL AND external_event_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      input.organizationId,
      input.projectId,
      input.integrationId,
      input.externalEventId,
      input.eventType,
      input.severity,
      JSON.stringify(input.metadata),
    ],
  );
  if (inserted.rows[0]) {
    return { eventId: String(inserted.rows[0].id) };
  }
  const existing = await db.query(
    `SELECT id
     FROM security.events
     WHERE integration_id = $1 AND external_event_id = $2`,
    [input.integrationId, input.externalEventId],
  );
  return { eventId: String(existing.rows[0].id) };
}
