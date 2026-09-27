/**
 * Clean security-event emitter for Kode modules.
 * Scrubs secrets from metadata. Never stores passwords/tokens.
 */
import { db } from '../db/pool.js';

const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'new_password',
  'current_password',
  'old_password',
  'token',
  'access_token',
  'refresh_token',
  'csrf_token',
  'authorization',
  'cookie',
  'secret',
  'api_key',
  'apikey',
  'private_key',
  'client_secret',
]);

export type SecurityEventInput = {
  organizationId: string;
  eventType: string;
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  riskScore?: number;
  successful?: boolean;
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestMethod?: string | null;
  endpoint?: string | null;
  httpStatus?: number | null;
  requestId?: string | null;
  projectId?: string | null;
  assetId?: string | null;
  systemId?: string | null;
  attackCategory?: string | null;
  metadata?: Record<string, unknown>;
};

export function scrubSecurityMetadata(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (
      FORBIDDEN_METADATA_KEYS.has(lower) ||
      lower.includes('password') ||
      lower.includes('secret') ||
      lower.endsWith('_token') ||
      lower.endsWith('token')
    ) {
      out[key] = '[redacted]';
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrubSecurityMetadata(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function recordSecurityEvent(input: SecurityEventInput) {
  const metadata = scrubSecurityMetadata(input.metadata);
  const severity = input.severity ?? 'medium';
  const riskScore = Math.max(0, Number(input.riskScore ?? 0));

  const result = await db.query(
    `INSERT INTO security.events (
       organization_id, user_id, ip_address, user_agent,
       request_method, endpoint, event_type, severity, risk_score,
       successful, system_id, project_id, asset_id, request_id,
       http_status, attack_category, metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb
     )
     RETURNING id, created_at`,
    [
      input.organizationId,
      input.userId ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      input.requestMethod ?? null,
      input.endpoint ?? null,
      input.eventType,
      severity,
      riskScore,
      Boolean(input.successful),
      input.systemId ?? null,
      input.projectId ?? null,
      input.assetId ?? null,
      input.requestId ?? null,
      input.httpStatus ?? null,
      input.attackCategory ?? null,
      JSON.stringify(metadata),
    ],
  );

  const eventId = result.rows[0].id as string;

  try {
    const { runBehavioralDetection } = await import('./detection.js');
    await runBehavioralDetection({
      organizationId: input.organizationId,
      eventId,
      eventType: input.eventType,
      ipAddress: input.ipAddress ?? null,
      systemId: input.systemId ?? null,
    });
  } catch {
    // Detection must never break event recording.
  }

  return {
    id: eventId,
    createdAt: result.rows[0].created_at as Date,
  };
}
