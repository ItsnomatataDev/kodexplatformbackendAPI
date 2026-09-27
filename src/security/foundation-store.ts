import type { PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { ConflictError, NotFoundError } from '../http/errors.js';

type Row = Record<string, unknown>;

function iso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  );
}

function mapProject(row: Row) {
  return {
    ...row,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    metadata: row.metadata ?? {},
    asset_count: row.asset_count == null ? undefined : Number(row.asset_count),
  };
}

function mapAsset(row: Row) {
  return {
    ...row,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    metadata: row.metadata ?? {},
  };
}

function mapIntegration(row: Row) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    project_id: row.project_id,
    slug: row.slug,
    name: row.name,
    integration_type: row.integration_type,
    status: row.status,
    credential_ref: row.credential_ref ?? null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

async function insertAudit(
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  input: {
    action: string;
    resourceType: string;
    resourceId: string;
    reason?: string | null;
    resultingState?: Record<string, unknown> | null;
  },
) {
  await client.query(
    `INSERT INTO security.audit_log (
       organization_id, actor_user_id, action, resource_type, resource_id,
       resulting_state, reason
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      organizationId,
      actorUserId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.resultingState ? JSON.stringify(input.resultingState) : null,
      input.reason ?? null,
    ],
  );
}

async function requireProject(
  client: PoolClient,
  organizationId: string,
  projectId: string,
) {
  const result = await client.query(
    `SELECT * FROM security.projects
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, projectId],
  );
  if (!result.rows[0]) {
    throw new NotFoundError('PROJECT_NOT_FOUND', 'Security project not found.');
  }
  return result.rows[0] as Row;
}

export async function getSecurityProject(organizationId: string, projectId: string) {
  return withTransaction(async (client) => {
    const row = await requireProject(client, organizationId, projectId);
    return mapProject(row);
  });
}

export async function createSecurityProject(
  organizationId: string,
  actorUserId: string,
  input: {
    slug: string;
    name: string;
    description?: string | null;
    criticality: string;
    environment: string;
  },
) {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO security.projects (
           organization_id, slug, name, description, criticality, environment, owner_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          organizationId,
          input.slug,
          input.name,
          input.description ?? null,
          input.criticality,
          input.environment,
          actorUserId,
        ],
      );
      const row = result.rows[0] as Row;
      await insertAudit(client, organizationId, actorUserId, {
        action: 'project.create',
        resourceType: 'security.project',
        resourceId: String(row.id),
        resultingState: {
          slug: input.slug,
          name: input.name,
          environment: input.environment,
          criticality: input.criticality,
        },
      });
      return mapProject(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'PROJECT_SLUG_TAKEN',
        'A security project with this slug already exists.',
      );
    }
    throw error;
  }
}

export async function updateSecurityProject(
  organizationId: string,
  actorUserId: string,
  projectId: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: string;
    criticality?: string;
    environment?: string;
  },
  auditAction = 'project.update',
) {
  return withTransaction(async (client) => {
    await requireProject(client, organizationId, projectId);
    const result = await client.query(
      `UPDATE security.projects
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           status = COALESCE($5, status),
           criticality = COALESCE($6, criticality),
           environment = COALESCE($7, environment),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        projectId,
        patch.name ?? null,
        patch.description === undefined ? null : patch.description,
        patch.status ?? null,
        patch.criticality ?? null,
        patch.environment ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('PROJECT_NOT_FOUND', 'Security project not found.');
    }
    const row = result.rows[0] as Row;
    await insertAudit(client, organizationId, actorUserId, {
        action: auditAction,
      resourceType: 'security.project',
      resourceId: projectId,
      resultingState: {
        name: row.name,
        status: row.status,
        environment: row.environment,
        criticality: row.criticality,
      },
    });
    return mapProject(row);
  });
}

export async function retireSecurityProject(
  organizationId: string,
  actorUserId: string,
  projectId: string,
) {
  return updateSecurityProject(
    organizationId,
    actorUserId,
    projectId,
    { status: 'retired' },
    'project.retire',
  );
}

export async function createSecurityAsset(
  organizationId: string,
  actorUserId: string,
  input: {
    projectId: string;
    slug: string;
    name: string;
    assetType: string;
    environment: string;
    hostname?: string | null;
    criticality: string;
  },
) {
  try {
    return await withTransaction(async (client) => {
      await requireProject(client, organizationId, input.projectId);
      const result = await client.query(
        `INSERT INTO security.assets (
           organization_id, project_id, slug, name, asset_type, environment,
           hostname, criticality, owner_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          organizationId,
          input.projectId,
          input.slug,
          input.name,
          input.assetType,
          input.environment,
          input.hostname ?? null,
          input.criticality,
          actorUserId,
        ],
      );
      const row = result.rows[0] as Row;
      await insertAudit(client, organizationId, actorUserId, {
        action: 'asset.create',
        resourceType: 'security.asset',
        resourceId: String(row.id),
        resultingState: {
          slug: input.slug,
          name: input.name,
          asset_type: input.assetType,
          project_id: input.projectId,
        },
      });
      return mapAsset(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'ASSET_SLUG_TAKEN',
        'A security asset with this slug already exists.',
      );
    }
    throw error;
  }
}

export async function listProjectAssets(
  organizationId: string,
  projectId: string,
  page: { limit?: number; offset?: number },
) {
  return withTransaction(async (client) => {
    await requireProject(client, organizationId, projectId);
    const limit = listLimit(page.limit);
    const result = await client.query(
      `SELECT * FROM security.assets
       WHERE organization_id = $1 AND project_id = $2
       ORDER BY name ASC, id ASC
       LIMIT $3 OFFSET $4`,
      [organizationId, projectId, limit + 1, listOffset(page.offset)],
    );
    const paged = pageOf(result.rows.map((row) => mapAsset(row as Row)), limit);
    return { assets: paged.rows, hasMore: paged.hasMore };
  });
}

export async function updateSecurityAsset(
  organizationId: string,
  actorUserId: string,
  projectId: string,
  assetId: string,
  patch: {
    name?: string;
    assetType?: string;
    environment?: string;
    hostname?: string | null;
    criticality?: string;
    status?: string;
  },
  auditAction = 'asset.update',
) {
  return withTransaction(async (client) => {
    await requireProject(client, organizationId, projectId);
    const result = await client.query(
      `UPDATE security.assets
       SET name = COALESCE($4, name),
           asset_type = COALESCE($5, asset_type),
           environment = COALESCE($6, environment),
           hostname = COALESCE($7, hostname),
           criticality = COALESCE($8, criticality),
           status = COALESCE($9, status),
           updated_at = NOW()
       WHERE organization_id = $1 AND project_id = $2 AND id = $3
       RETURNING *`,
      [
        organizationId,
        projectId,
        assetId,
        patch.name ?? null,
        patch.assetType ?? null,
        patch.environment ?? null,
        patch.hostname === undefined ? null : patch.hostname,
        patch.criticality ?? null,
        patch.status ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('ASSET_NOT_FOUND', 'Security asset not found.');
    }
    const row = result.rows[0] as Row;
    await insertAudit(client, organizationId, actorUserId, {
        action: auditAction,
      resourceType: 'security.asset',
      resourceId: assetId,
      resultingState: {
        name: row.name,
        status: row.status,
        asset_type: row.asset_type,
      },
    });
    return mapAsset(row);
  });
}

export async function retireSecurityAsset(
  organizationId: string,
  actorUserId: string,
  projectId: string,
  assetId: string,
) {
  return updateSecurityAsset(
    organizationId,
    actorUserId,
    projectId,
    assetId,
    { status: 'retired' },
    'asset.retire',
  );
}

export async function createSecurityIntegration(
  organizationId: string,
  actorUserId: string,
  input: {
    projectId: string;
    slug: string;
    name: string;
    integrationType: string;
    credentialRef?: string | null;
  },
) {
  try {
    return await withTransaction(async (client) => {
      await requireProject(client, organizationId, input.projectId);
      const result = await client.query(
        `INSERT INTO security.integrations (
           organization_id, project_id, slug, name, integration_type, credential_ref
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, organization_id, project_id, slug, name, integration_type,
                   status, credential_ref, created_at, updated_at`,
        [
          organizationId,
          input.projectId,
          input.slug,
          input.name,
          input.integrationType,
          input.credentialRef ?? null,
        ],
      );
      const row = result.rows[0] as Row;
      await insertAudit(client, organizationId, actorUserId, {
        action: 'integration.create',
        resourceType: 'security.integration',
        resourceId: String(row.id),
        resultingState: {
          slug: input.slug,
          name: input.name,
          integration_type: input.integrationType,
          status: 'active',
        },
      });
      return mapIntegration(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'INTEGRATION_SLUG_TAKEN',
        'A security integration with this slug already exists.',
      );
    }
    throw error;
  }
}

export async function listProjectIntegrations(
  organizationId: string,
  projectId: string,
  page: { limit?: number; offset?: number },
) {
  return withTransaction(async (client) => {
    await requireProject(client, organizationId, projectId);
    const limit = listLimit(page.limit);
    const result = await client.query(
      `SELECT id, organization_id, project_id, slug, name, integration_type,
              status, credential_ref, created_at, updated_at
       FROM security.integrations
       WHERE organization_id = $1 AND project_id = $2
       ORDER BY name ASC, id ASC
       LIMIT $3 OFFSET $4`,
      [organizationId, projectId, limit + 1, listOffset(page.offset)],
    );
    const paged = pageOf(
      result.rows.map((row) => mapIntegration(row as Row)),
      limit,
    );
    return { integrations: paged.rows, hasMore: paged.hasMore };
  });
}

export async function revokeSecurityIntegration(
  organizationId: string,
  actorUserId: string,
  projectId: string,
  integrationId: string,
  reason: string,
) {
  return withTransaction(async (client) => {
    await requireProject(client, organizationId, projectId);
    const result = await client.query(
      `UPDATE security.integrations
       SET status = 'revoked',
           credential_ref = NULL,
           updated_at = NOW()
       WHERE organization_id = $1 AND project_id = $2 AND id = $3
         AND status <> 'revoked'
       RETURNING id, organization_id, project_id, slug, name, integration_type,
                 status, credential_ref, created_at, updated_at`,
      [organizationId, projectId, integrationId],
    );
    if (!result.rows[0]) {
      const existing = await client.query(
        `SELECT id FROM security.integrations
         WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
        [organizationId, projectId, integrationId],
      );
      if (!existing.rows[0]) {
        throw new NotFoundError(
          'INTEGRATION_NOT_FOUND',
          'Security integration not found.',
        );
      }
      throw new ConflictError(
        'INTEGRATION_ALREADY_REVOKED',
        'Security integration is already revoked.',
      );
    }
    const row = result.rows[0] as Row;
    await insertAudit(client, organizationId, actorUserId, {
      action: 'integration.revoke',
      resourceType: 'security.integration',
      resourceId: integrationId,
      reason,
      resultingState: { status: 'revoked', slug: row.slug },
    });
    return mapIntegration(row);
  });
}
