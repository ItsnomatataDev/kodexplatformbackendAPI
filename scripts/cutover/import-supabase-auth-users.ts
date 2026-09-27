/**
 * Import missing auth users (+ profiles/memberships) from live Supabase Postgres
 * into Kode, then optionally mint password-reset links.
 *
 * Usage (on a host that can reach both DBs, or via SSH tunnel):
 *   npx tsx scripts/cutover/import-supabase-auth-users.ts --env-file .env.vps
 *   npx tsx scripts/cutover/import-supabase-auth-users.ts --env-file .env.vps --mint-links --out .local/password-reset-links.tsv
 *
 * Env for Supabase source (defaults match VPS docker):
 *   SUPABASE_DATABASE_URL=postgres://postgres:...@127.0.0.1:5432/postgres
 *   or SUPABASE_DATABASE_HOST / PORT / USER / PASSWORD / NAME
 */
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);

function readFlagValue(name: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')));
const includeInactive = flags.has('--include-inactive');
const mintLinks = flags.has('--mint-links');
const dryRun = flags.has('--dry-run');
const outPath = readFlagValue('--out') ?? '.local/password-reset-links.tsv';
const ttlSeconds = Number(readFlagValue('--ttl-seconds') ?? '3600');

const envFile = readFlagValue('--env-file');
if (ttlSeconds) {
  process.env.AUTH_PASSWORD_RESET_TTL_SECONDS = String(ttlSeconds);
}
loadDotenv({ override: true, path: envFile || undefined });
if (ttlSeconds) {
  process.env.AUTH_PASSWORD_RESET_TTL_SECONDS = String(ttlSeconds);
}

function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

function supabaseConfig() {
  if (process.env.SUPABASE_DATABASE_URL) {
    return { connectionString: process.env.SUPABASE_DATABASE_URL };
  }
  return {
    host: process.env.SUPABASE_DATABASE_HOST ?? '127.0.0.1',
    port: Number(process.env.SUPABASE_DATABASE_PORT ?? '5432'),
    user: process.env.SUPABASE_DATABASE_USER ?? 'postgres',
    password: process.env.SUPABASE_DATABASE_PASSWORD ?? '',
    database: process.env.SUPABASE_DATABASE_NAME ?? 'postgres',
  };
}

async function main() {
  const { env } = await import('../../src/config/env.js');
  const { db } = await import('../../src/db/pool.js');
  const { withTransaction } = await import('../../src/db/transaction.js');
  const { generateOpaqueToken, hashOpaqueToken } = await import(
    '../../src/auth/opaque-token.js'
  );
  const { PostgresAuthStore } = await import('../../src/auth/postgres-store.js');

  const source = new pg.Client(supabaseConfig());
  await source.connect();

  try {
    const missing = await source.query<{
      id: string;
      email: string;
      created_at: Date;
      updated_at: Date | null;
      full_name: string | null;
      organization_id: string | null;
      office_id: string | null;
      primary_role: string | null;
      is_active: boolean | null;
      account_status: string | null;
      phone: string | null;
      avatar_url: string | null;
      job_title: string | null;
      department: string | null;
      member_id: string | null;
      member_role: string | null;
      member_status: string | null;
      joined_at: Date | null;
    }>(
      `
        SELECT
          u.id,
          u.email,
          u.created_at,
          u.updated_at,
          p.full_name,
          p.organization_id,
          p.office_id,
          p.primary_role::text AS primary_role,
          p.is_active,
          p.account_status::text AS account_status,
          p.phone,
          p.avatar_url,
          p.job_title,
          p.department,
          m.id AS member_id,
          m.role::text AS member_role,
          m.status::text AS member_status,
          m.joined_at
        FROM auth.users u
        LEFT JOIN public.profiles p ON p.id = u.id
        LEFT JOIN LATERAL (
          SELECT *
          FROM public.organization_members om
          WHERE om.user_id = u.id
          ORDER BY CASE WHEN om.status::text = 'active' THEN 0 ELSE 1 END, om.joined_at DESC
          LIMIT 1
        ) m ON true
        WHERE u.deleted_at IS NULL
          AND u.email IS NOT NULL
          AND btrim(u.email) <> ''
        ORDER BY u.email
      `,
    );

    const existing = await db.query<{ email_normalized: string | null }>(
      `SELECT email_normalized FROM identity.users WHERE email_normalized IS NOT NULL`,
    );
    const existingEmails = new Set(
      existing.rows.map((r) => r.email_normalized).filter(Boolean) as string[],
    );

    const candidates = missing.rows.filter((row) => {
      const emailNorm = normalizeEmail(row.email);
      if (!emailNorm || existingEmails.has(emailNorm)) return false;
      if (includeInactive) return true;
      const status = (row.account_status ?? 'active').toLowerCase();
      if (status === 'rejected' || status === 'deleted') return false;
      if (row.is_active === false && status !== 'active') return false;
      if (emailNorm.endsWith('@example.com')) return false;
      return status === 'active' || status === 'pending' || status === 'pending_approval';
    });

    console.error(
      `[supabase-import] candidates=${candidates.length} includeInactive=${includeInactive} dryRun=${dryRun}`,
    );
    for (const row of candidates) {
      console.error(
        `  ${row.email} status=${row.account_status} role=${row.member_role ?? row.primary_role}`,
      );
    }

    if (dryRun) return;

    let imported = 0;
    await withTransaction(async (client) => {
      for (const row of candidates) {
        const emailNorm = normalizeEmail(row.email)!;
        const accountStatus =
          row.account_status === 'pending_approval'
            ? 'pending_approval'
            : row.account_status === 'pending'
              ? 'pending'
              : 'active';
        const roleKey = (row.member_role ?? row.primary_role ?? 'employee')
          .trim()
          .toLowerCase();

        await client.query(
          `
            INSERT INTO identity.users (
              id, email, email_normalized, created_at, updated_at,
              is_active, account_status, deleted_at, legacy_source, legacy_id
            ) VALUES ($1,$2,$3,$4,now(),$5,$6,NULL,'supabase',$1)
            ON CONFLICT (id) DO UPDATE SET
              email = EXCLUDED.email,
              email_normalized = EXCLUDED.email_normalized,
              is_active = EXCLUDED.is_active,
              account_status = EXCLUDED.account_status,
              updated_at = now()
          `,
          [
            row.id,
            row.email.trim(),
            emailNorm,
            row.created_at,
            row.is_active !== false,
            accountStatus,
          ],
        );

        await client.query(
          `
            INSERT INTO identity.user_profiles (
              user_id, full_name, phone, avatar_url, job_title, department,
              office_id, primary_role_key, metadata, email_preferences,
              leave_days_total, leave_days_remaining, created_at, updated_at,
              legacy_source, legacy_id
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,'{}'::jsonb,22,22,now(),now(),'supabase',$1
            )
            ON CONFLICT (user_id) DO UPDATE SET
              full_name = COALESCE(EXCLUDED.full_name, identity.user_profiles.full_name),
              phone = COALESCE(EXCLUDED.phone, identity.user_profiles.phone),
              office_id = COALESCE(EXCLUDED.office_id, identity.user_profiles.office_id),
              primary_role_key = COALESCE(EXCLUDED.primary_role_key, identity.user_profiles.primary_role_key),
              updated_at = now()
          `,
          [
            row.id,
            row.full_name,
            row.phone,
            row.avatar_url,
            row.job_title,
            row.department,
            row.office_id,
            roleKey,
          ],
        );

        if (row.organization_id) {
          const membershipId = row.member_id ?? randomUUID();
          await client.query(
            `
              INSERT INTO organizations.memberships (
                id, organization_id, user_id, role_id, role_key, status,
                joined_at, office_id, created_at, updated_at, legacy_source, legacy_id
              ) VALUES (
                $1,$2,$3,
                (SELECT id FROM organizations.roles
                  WHERE organization_id = $2 AND role_key = $4 LIMIT 1),
                $4,
                COALESCE($5, 'active'),
                COALESCE($6, now()),
                $7,
                now(), now(), 'supabase', $1
              )
              ON CONFLICT (organization_id, user_id) DO UPDATE SET
                role_key = EXCLUDED.role_key,
                role_id = EXCLUDED.role_id,
                status = EXCLUDED.status,
                office_id = COALESCE(EXCLUDED.office_id, organizations.memberships.office_id),
                updated_at = now()
            `,
            [
              membershipId,
              row.organization_id,
              row.id,
              roleKey,
              row.member_status ?? 'active',
              row.joined_at,
              row.office_id,
            ],
          );
        }

        imported += 1;
      }
    });

    console.error(`[supabase-import] imported=${imported}`);

    if (!mintLinks) return;

    if (!env.appPublicUrl) {
      throw new Error('APP_PUBLIC_URL must be set to mint reset links.');
    }

    const targets = await db.query<{ id: string; email: string }>(
      `
        SELECT u.id, u.email
        FROM identity.users u
        LEFT JOIN identity.password_credentials c ON c.user_id = u.id
        WHERE u.deleted_at IS NULL
          AND u.email IS NOT NULL
          AND btrim(u.email) <> ''
          AND u.account_status IN ('active', 'pending', 'pending_approval')
          AND c.user_id IS NULL
        ORDER BY u.email
      `,
    );

    const store = new PostgresAuthStore();
    const lines = ['email\treset_url'];
    for (const row of targets.rows) {
      const resetToken = generateOpaqueToken();
      const now = new Date();
      await withTransaction(async (client) => {
        await store.invalidatePasswordResetTokensForUser(row.id, now, client);
        await store.createPasswordResetToken(
          {
            id: randomUUID(),
            userId: row.id,
            tokenHash: hashOpaqueToken(env.auth.tokenSecret, resetToken),
            expiresAt: new Date(Date.now() + env.auth.passwordResetTtlSeconds * 1000),
          },
          client,
        );
      });
      lines.push(
        `${row.email}\t${env.appPublicUrl}/reset-password?token=${encodeURIComponent(resetToken)}`,
      );
    }

    const absolute = path.resolve(outPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.error(
      `[supabase-import] minted=${targets.rows.length} links ttl=${env.auth.passwordResetTtlSeconds}s -> ${absolute}`,
    );
  } finally {
    await source.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
