import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { randomToken, bootstrapDigest } from '../crypto/secrets.js';
import { validatePermissions } from '../authorization/permissions.js';
import type { AuditMeta } from '../audit/events.js';

async function operatorAction<T>(
  pool: pg.Pool,
  c: ProvisioningConfig,
  meta: AuditMeta,
  action: string,
  login: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    await pool.query(
      'SELECT infrastructure.record_operator_denial($1,$2,$3,$4,$5)',
      [
        c.organizationId,
        login?.trim().toLowerCase().slice(0, 254) ?? null,
        action,
        meta.actor,
        meta.requestId,
      ],
    );
    throw new Error('Infrastructure operator action rejected');
  }
}

// The database validates again. No direct table grants or runtime keys are needed.
export async function provisionAccount(
  pool: pg.Pool,
  c: ProvisioningConfig,
  input: { login: string; displayName: string; permissions: string[] },
  meta: AuditMeta,
) {
  return operatorAction(pool, c, meta, 'provisioned', input.login, async () => {
    const permissions = validatePermissions(input.permissions);
    const capability = randomToken();
    const result = await pool.query(
      'SELECT infrastructure.provision_account($1,$2,$3,$4,$5,$6,$7) AS id',
      [
        c.organizationId,
        input.login.trim().toLowerCase(),
        input.displayName,
        permissions,
        bootstrapDigest(capability),
        meta.actor,
        meta.requestId,
      ],
    );
    return { accountId: result.rows[0].id as string, capability };
  });
}
export async function manageAccount(
  pool: pg.Pool,
  c: ProvisioningConfig,
  login: string,
  action: 'disable' | 'revoke' | 'reset' | 'permissions',
  meta: AuditMeta,
  permissions: string[] = [],
) {
  return operatorAction(pool, c, meta, action, login, async () => {
    const grants =
      action === 'permissions' ? validatePermissions(permissions) : [];
    const capability = action === 'reset' ? randomToken() : undefined;
    await pool.query(
      'SELECT infrastructure.manage_account($1,$2,$3,$4,$5,$6,$7)',
      [
        c.organizationId,
        login.trim().toLowerCase(),
        action,
        grants,
        capability ? bootstrapDigest(capability) : null,
        meta.actor,
        meta.requestId,
      ],
    );
    return { capability };
  });
}
export async function registerServer(
  pool: pg.Pool,
  c: ProvisioningConfig,
  label: string,
  address: string,
  meta: AuditMeta,
) {
  return operatorAction(pool, c, meta, 'server.registered', null, async () => {
    const result = await pool.query(
      'SELECT infrastructure.register_server($1,$2,$3,$4,$5) AS id',
      [c.organizationId, label, address, meta.actor, meta.requestId],
    );
    return result.rows[0] as { id: string };
  });
}
