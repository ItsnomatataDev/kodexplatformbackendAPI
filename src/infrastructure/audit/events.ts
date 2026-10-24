import type { PoolClient } from 'pg';
export type AuditMeta = { requestId: string; actor: string };
export async function audit(
  db: PoolClient,
  meta: AuditMeta,
  action: string,
  accountId: string | null,
  successful = true,
  reason: string | null = null,
) {
  // Only controlled action/reason strings are accepted by callers. No request body metadata.
  await db.query(
    `INSERT INTO infrastructure.audit_events(account_id,action,successful,actor,request_id,reason) VALUES($1,$2,$3,$4,$5,$6)`,
    [accountId, action, successful, meta.actor, meta.requestId, reason],
  );
}
