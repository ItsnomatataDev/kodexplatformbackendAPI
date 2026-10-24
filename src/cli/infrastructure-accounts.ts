import { randomUUID } from 'node:crypto';
import { readProvisioningConfig } from '../infrastructure/config.js';
import {
  checkDatabaseRole,
  infrastructurePool,
} from '../infrastructure/db/pool.js';
import {
  provisionAccount,
  manageAccount,
  registerServer,
} from '../infrastructure/auth/provisioning.js';
async function main() {
  const [action, login, displayOrPermissions, permissionList, ...extra] =
    process.argv.slice(2);
  if (
    extra.length ||
    ![
      'create',
      'disable',
      'revoke',
      'reset',
      'permissions',
      'register-server',
    ].includes(action ?? '') ||
    !login
  )
    throw new Error(
      'Usage: infra:accounts create LOGIN DISPLAY_NAME PERMISSIONS | disable/revoke/reset LOGIN | permissions LOGIN PERMISSIONS | register-server LABEL DISPLAY_ADDRESS',
    );
  const operator = process.env.INFRA_OPERATOR;
  if (!operator || operator.length > 100)
    throw new Error('Set INFRA_OPERATOR to the accountable operator identity');
  const config = readProvisioningConfig();
  const pool = infrastructurePool(config);
  try {
    await checkDatabaseRole(pool, 'kode_infra_provisioner');
    const meta = { requestId: randomUUID(), actor: `operator:${operator}` };
    let result: unknown;
    if (action === 'create')
      result = await provisionAccount(
        pool,
        config,
        {
          login,
          displayName: displayOrPermissions ?? '',
          permissions: (permissionList ?? '').split(','),
        },
        meta,
      );
    else if (action === 'register-server')
      result = await registerServer(
        pool,
        config,
        login,
        displayOrPermissions ?? '',
        meta,
      );
    else
      result = await manageAccount(
        pool,
        config,
        login,
        action as 'disable' | 'revoke' | 'reset' | 'permissions',
        meta,
        (displayOrPermissions ?? '').split(','),
      );
    // Capabilities are intentionally shown once to the controlled operator, never accepted in argv.
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Infrastructure operator action failed; verify command, dedicated configuration and permissions',
  );
  process.exit(1);
});
