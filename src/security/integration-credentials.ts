import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashOpaqueToken, tokensMatch } from '../auth/opaque-token.js';
import { env } from '../config/env.js';
import { withTransaction } from '../db/transaction.js';
import { listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { ConflictError, NotFoundError } from '../http/errors.js';

const KEY_PREFIX = 'kint_';
const DEFAULT_TTL_DAYS = 90;
const MAX_TTL_DAYS = 90;
export const INTEGRATION_CREDENTIAL_SCOPE = 'events:write';

/** Future ingest calls enforceRateLimit with this key. PostgreSQL remains authoritative. */
export function integrationCredentialRateLimitKey(keyId: string) {
  return `sec:integration-credential:${keyId}`;
}

export type IntegrationCredentialContext = {
  credentialId: string;
  integrationId: string;
  projectId: string;
  organizationId: string;
  scope: string;
};

type IssueResult = {
  credential_id: string;
  credential: string;
  expires_at: string;
  scope: string;
};

type CredentialMeta = {
  credential_id: string;
  key_id: string;
  scope: string;
  created_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

function iso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function hashSecret(secret: string) {
  return hashOpaqueToken(env.auth.tokenSecret, secret);
}

function mintCredential() {
  const keyId = randomBytes(9).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return {
    keyId,
    secret,
    credential: `${KEY_PREFIX}${keyId}_${secret}`,
    secretHash: hashSecret(secret),
  };
}

export function parseIntegrationCredential(credential: string) {
  const match = /^kint_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{20,})$/.exec(
    credential,
  );
  if (!match) return null;
  return { keyId: match[1]!, secret: match[2]! };
}

function expiresAtFromDays(days: number) {
  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + days);
  return expires;
}

async function insertAudit(
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  input: {
    action: string;
    resourceId: string;
    reason?: string | null;
    resultingState: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO security.audit_log (
       organization_id, actor_user_id, action, resource_type, resource_id,
       resulting_state, reason
     ) VALUES ($1,$2,$3,'security.integration_credential',$4,$5::jsonb,$6)`,
    [
      organizationId,
      actorUserId,
      input.action,
      input.resourceId,
      JSON.stringify(input.resultingState),
      input.reason ?? null,
    ],
  );
}

async function requireActiveIntegration(
  client: PoolClient,
  organizationId: string,
  projectId: string,
  integrationId: string,
) {
  const result = await client.query(
    `SELECT id, status, project_id
     FROM security.integrations
     WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
    [organizationId, projectId, integrationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError(
      'INTEGRATION_NOT_FOUND',
      'Security integration not found.',
    );
  }
  if (row.status !== 'active') {
    throw new ConflictError(
      'INTEGRATION_NOT_ACTIVE',
      'Credentials can only be issued for an active integration.',
    );
  }
  return row;
}

export async function issueIntegrationCredential(
  organizationId: string,
  actorUserId: string,
  projectId: string,
  integrationId: string,
  ttlDays = DEFAULT_TTL_DAYS,
): Promise<IssueResult> {
  const days = Math.min(Math.max(ttlDays, 1), MAX_TTL_DAYS);
  const minted = mintCredential();
  const expiresAt = expiresAtFromDays(days);
  return withTransaction(async (client) => {
    await requireActiveIntegration(
      client,
      organizationId,
      projectId,
      integrationId,
    );
    const inserted = await client.query(
      `INSERT INTO security.integration_credentials (
         organization_id, integration_id, key_id, secret_hash, scope,
         expires_at, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, expires_at, scope`,
      [
        organizationId,
        integrationId,
        minted.keyId,
        minted.secretHash,
        INTEGRATION_CREDENTIAL_SCOPE,
        expiresAt.toISOString(),
        actorUserId,
      ],
    );
    const row = inserted.rows[0];
    await insertAudit(client, organizationId, actorUserId, {
      action: 'credential.issue',
      resourceId: String(row.id),
      resultingState: {
        integration_id: integrationId,
        project_id: projectId,
        key_id: minted.keyId,
        scope: row.scope,
        expires_at: iso(row.expires_at),
      },
    });
    return {
      credential_id: String(row.id),
      credential: minted.credential,
      expires_at: iso(row.expires_at)!,
      scope: String(row.scope),
    };
  });
}

export async function listIntegrationCredentials(
  organizationId: string,
  projectId: string,
  integrationId: string,
  page: { limit?: number; offset?: number },
) {
  return withTransaction(async (client) => {
    const integration = await client.query(
      `SELECT id FROM security.integrations
       WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
      [organizationId, projectId, integrationId],
    );
    if (!integration.rows[0]) {
      throw new NotFoundError(
        'INTEGRATION_NOT_FOUND',
        'Security integration not found.',
      );
    }
    const limit = listLimit(page.limit);
    const result = await client.query(
      `SELECT id, key_id, scope, created_at, expires_at, revoked_at, last_used_at
       FROM security.integration_credentials
       WHERE organization_id = $1 AND integration_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [organizationId, integrationId, limit + 1, listOffset(page.offset)],
    );
    const mapped: CredentialMeta[] = result.rows.map((row) => ({
      credential_id: String(row.id),
      key_id: String(row.key_id),
      scope: String(row.scope),
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      revoked_at: iso(row.revoked_at),
      last_used_at: iso(row.last_used_at),
    }));
    const paged = pageOf(mapped, limit);
    return { credentials: paged.rows, hasMore: paged.hasMore };
  });
}

export async function revokeIntegrationCredential(
  organizationId: string,
  actorUserId: string,
  projectId: string,
  integrationId: string,
  credentialId: string,
  reason: string,
) {
  return withTransaction(async (client) => {
    const integration = await client.query(
      `SELECT id FROM security.integrations
       WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
      [organizationId, projectId, integrationId],
    );
    if (!integration.rows[0]) {
      throw new NotFoundError(
        'INTEGRATION_NOT_FOUND',
        'Security integration not found.',
      );
    }
    const result = await client.query(
      `UPDATE security.integration_credentials
       SET revoked_at = NOW()
       WHERE organization_id = $1
         AND integration_id = $2
         AND id = $3
         AND revoked_at IS NULL
       RETURNING id, key_id, scope, created_at, expires_at, revoked_at, last_used_at`,
      [organizationId, integrationId, credentialId],
    );
    if (!result.rows[0]) {
      const existing = await client.query(
        `SELECT id, revoked_at FROM security.integration_credentials
         WHERE organization_id = $1 AND integration_id = $2 AND id = $3`,
        [organizationId, integrationId, credentialId],
      );
      if (!existing.rows[0]) {
        throw new NotFoundError(
          'CREDENTIAL_NOT_FOUND',
          'Integration credential not found.',
        );
      }
      throw new ConflictError(
        'CREDENTIAL_ALREADY_REVOKED',
        'Integration credential is already revoked.',
      );
    }
    const row = result.rows[0];
    await insertAudit(client, organizationId, actorUserId, {
      action: 'credential.revoke',
      resourceId: credentialId,
      reason,
      resultingState: {
        integration_id: integrationId,
        project_id: projectId,
        key_id: row.key_id,
        scope: row.scope,
        revoked_at: iso(row.revoked_at),
      },
    });
    return {
      credential_id: String(row.id),
      key_id: String(row.key_id),
      scope: String(row.scope),
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      revoked_at: iso(row.revoked_at),
      last_used_at: iso(row.last_used_at),
    };
  });
}

export async function verifyIntegrationCredential(
  presented: string,
): Promise<
  | { ok: true; context: IntegrationCredentialContext }
  | { ok: false }
> {
  const parsed = parseIntegrationCredential(presented.trim());
  const dummy = hashSecret('kode-integration-credential-dummy');
  if (!parsed) {
    tokensMatch(dummy, hashSecret('invalid'));
    return { ok: false };
  }
  const presentedHash = hashSecret(parsed.secret);
  const result = await withTransaction(async (client) => {
    const found = await client.query(
      `SELECT c.id, c.secret_hash, c.scope, c.expires_at, c.revoked_at,
              i.id AS integration_id, i.status AS integration_status,
              i.project_id, i.organization_id
       FROM security.integration_credentials c
       JOIN security.integrations i
         ON i.id = c.integration_id
        AND i.organization_id = c.organization_id
       WHERE c.key_id = $1`,
      [parsed.keyId],
    );
    const row = found.rows[0];
    if (!row || !tokensMatch(String(row.secret_hash), presentedHash)) {
      tokensMatch(dummy, presentedHash);
      return null;
    }
    if (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      return null;
    }
    if (row.integration_status !== 'active') {
      return null;
    }
    await client.query(
      `UPDATE security.integration_credentials
       SET last_used_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [row.id, row.organization_id],
    );
    return {
      credentialId: String(row.id),
      integrationId: String(row.integration_id),
      projectId: String(row.project_id),
      organizationId: String(row.organization_id),
      scope: String(row.scope),
    } satisfies IntegrationCredentialContext;
  });
  if (!result) return { ok: false };
  return { ok: true, context: result };
}
