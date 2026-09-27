import { db } from '../db/pool.js';
import { NotFoundError } from '../http/errors.js';

export const AUTHENTICATION_FAILURE_BURST_RULE_ID = 'auth.authentication_failure_burst';

const WINDOW_MS = 60_000;
const THRESHOLD = 5;
const MAX_EVENTS = 100;
const EVENT_TYPE = 'LOGIN_FAILED';

type EventRow = {
  id: string;
  organization_id: string;
  project_id: string | null;
  integration_id: string | null;
  user_id: string | null;
  event_type: string;
  created_at: Date;
};

export type DetectionMatchResult =
  | { matched: false; ruleId: string }
  | {
      matched: true;
      ruleId: string;
      matchId: string;
      created: boolean;
    };

type TrustedSubject = { kind: 'user' | 'integration'; id: string };

function subjectOf(event: EventRow): TrustedSubject | null {
  if (event.user_id) return { kind: 'user', id: event.user_id };
  if (event.integration_id) return { kind: 'integration', id: event.integration_id };
  return null;
}

async function loadEvent(eventId: string): Promise<EventRow> {
  const result = await db.query(
    `SELECT id, organization_id, project_id, integration_id, user_id, event_type, created_at
     FROM security.events
     WHERE id = $1`,
    [eventId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError('SECURITY_EVENT_NOT_FOUND', 'Security event was not found.');
  }
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    project_id: row.project_id == null ? null : String(row.project_id),
    integration_id: row.integration_id == null ? null : String(row.integration_id),
    user_id: row.user_id == null ? null : String(row.user_id),
    event_type: String(row.event_type),
    created_at: new Date(row.created_at),
  };
}

async function loadWindow(event: EventRow, subject: TrustedSubject) {
  const from = new Date(event.created_at.getTime() - WINDOW_MS).toISOString();
  const params: unknown[] = [
    event.organization_id,
    event.project_id,
    EVENT_TYPE,
    from,
    event.created_at.toISOString(),
  ];
  const subjectSql =
    subject.kind === 'user'
      ? `user_id = $6`
      : `user_id IS NULL AND integration_id = $6`;
  params.push(subject.id);
  const result = await db.query(
    `SELECT id, created_at
     FROM security.events
     WHERE organization_id = $1
       AND project_id IS NOT DISTINCT FROM $2::uuid
       AND event_type = $3
       AND created_at >= $4::timestamptz
       AND created_at <= $5::timestamptz
       AND ${subjectSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ${MAX_EVENTS}`,
    params,
  );
  const windowEvents = result.rows
    .map((row) => ({
      id: String(row.id),
      createdAt: new Date(row.created_at).toISOString(),
    }))
    .reverse();
  return windowEvents;
}

async function persistMatch(input: {
  organizationId: string;
  projectId: string | null;
  integrationId: string | null;
  triggerEventId: string;
  evidence: Record<string, unknown>;
}) {
  const inserted = await db.query(
    `INSERT INTO security.detection_matches (
       organization_id, project_id, integration_id, rule_id, trigger_event_id,
       severity, confidence, evidence
     ) VALUES ($1,$2,$3,$4,$5,'high',1,$6::jsonb)
     ON CONFLICT (organization_id, rule_id, trigger_event_id) DO NOTHING
     RETURNING id`,
    [
      input.organizationId,
      input.projectId,
      input.integrationId,
      AUTHENTICATION_FAILURE_BURST_RULE_ID,
      input.triggerEventId,
      JSON.stringify(input.evidence),
    ],
  );
  if (inserted.rows[0]) {
    return { matchId: String(inserted.rows[0].id), created: true };
  }
  const existing = await db.query(
    `SELECT id
     FROM security.detection_matches
     WHERE organization_id = $1 AND rule_id = $2 AND trigger_event_id = $3`,
    [input.organizationId, AUTHENTICATION_FAILURE_BURST_RULE_ID, input.triggerEventId],
  );
  return { matchId: String(existing.rows[0].id), created: false };
}

export async function evaluateSecurityEvent(eventId: string): Promise<DetectionMatchResult> {
  const event = await loadEvent(eventId);
  const ruleId = AUTHENTICATION_FAILURE_BURST_RULE_ID;
  if (event.event_type !== EVENT_TYPE) return { matched: false, ruleId };
  const subject = subjectOf(event);
  if (!subject) return { matched: false, ruleId };
  const windowEvents = await loadWindow(event, subject);
  if (windowEvents.length < THRESHOLD) return { matched: false, ruleId };
  const anchor = windowEvents[0]!;
  const saved = await persistMatch({
    organizationId: event.organization_id,
    projectId: event.project_id,
    integrationId: subject.kind === 'integration' ? subject.id : event.integration_id,
    triggerEventId: anchor.id,
    evidence: {
      event_count: windowEvents.length,
      threshold: THRESHOLD,
      window_seconds: WINDOW_MS / 1000,
      window_start: anchor.createdAt,
      window_end: windowEvents[windowEvents.length - 1]!.createdAt,
      event_ids: windowEvents.map((row) => row.id),
      subject_kind: subject.kind,
      subject_id: subject.id,
      evaluated_event_id: event.id,
    },
  });
  return { matched: true, ruleId, matchId: saved.matchId, created: saved.created };
}
