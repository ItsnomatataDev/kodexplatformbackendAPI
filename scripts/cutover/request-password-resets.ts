/**
 * Cutover helper: email password-reset links to every Kode user who does not
 * yet have a password_credentials row (or --all to re-send everyone).
 *
 * Usage:
 *   npx tsx scripts/cutover/request-password-resets.ts
 *   npx tsx scripts/cutover/request-password-resets.ts --all
 *   npx tsx scripts/cutover/request-password-resets.ts --dry-run
 *   npx tsx scripts/cutover/request-password-resets.ts --delay-ms 2500
 *   npx tsx scripts/cutover/request-password-resets.ts --only you@example.com
 *   npx tsx scripts/cutover/request-password-resets.ts --print-links
 *   npx tsx scripts/cutover/request-password-resets.ts --print-links --out .local/links.tsv --ttl-seconds 86400
 *
 * --print-links creates reset tokens and prints URLs (no SMTP). Use when the
 * mail provider is quota-blocked. Treat output as secrets.
 *
 * Requires APP_PUBLIC_URL in .env. SMTP required unless --print-links.
 */
import { config as loadDotenv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);

function readFlagValue(name: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) {
    return eq.slice(name.length + 1);
  }
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

const ttlOverride = readFlagValue('--ttl-seconds');
if (ttlOverride) {
  process.env.AUTH_PASSWORD_RESET_TTL_SECONDS = ttlOverride;
}

const envFile = readFlagValue('--env-file');
const preservedTtl = process.env.AUTH_PASSWORD_RESET_TTL_SECONDS;
loadDotenv({ override: true, path: envFile || undefined });
if (ttlOverride && preservedTtl) {
  process.env.AUTH_PASSWORD_RESET_TTL_SECONDS = preservedTtl;
}

const flags = new Set(args.filter((arg) => arg.startsWith('--') && !arg.includes('=')));
const dryRun = flags.has('--dry-run');
const allUsers = flags.has('--all');
const printLinks = flags.has('--print-links');
const delayMs = Number(readFlagValue('--delay-ms') ?? (printLinks ? '0' : '2500'));
const onlyEmail = readFlagValue('--only')?.trim().toLowerCase();
const outPath = readFlagValue('--out');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { randomUUID } = await import('node:crypto');
  const { db } = await import('../../src/db/pool.js');
  const { env } = await import('../../src/config/env.js');
  const { createDefaultAuthLifecycle } = await import('../../src/auth/defaults.js');
  const { EmailDeliveryError } = await import('../../src/auth/email.js');
  const { generateOpaqueToken, hashOpaqueToken } = await import(
    '../../src/auth/opaque-token.js'
  );
  const { PostgresAuthStore } = await import('../../src/auth/postgres-store.js');
  const { withTransaction } = await import('../../src/db/transaction.js');

  const result = await db.query<{
    id: string;
    email: string | null;
    has_password: boolean;
  }>(
    `
      SELECT
        u.id,
        u.email,
        (c.user_id IS NOT NULL) AS has_password
      FROM identity.users u
      LEFT JOIN identity.password_credentials c ON c.user_id = u.id
      WHERE u.deleted_at IS NULL
        AND u.email IS NOT NULL
        AND btrim(u.email) <> ''
        AND u.account_status IN ('active', 'pending', 'pending_approval')
      ORDER BY u.email
    `,
  );

  let targets = result.rows.filter((row) => allUsers || !row.has_password);
  if (onlyEmail) {
    targets = targets.filter(
      (row) => String(row.email).trim().toLowerCase() === onlyEmail,
    );
  }

  console.error(
    `[password-cutover] users=${result.rows.length} targets=${targets.length} dryRun=${dryRun} all=${allUsers} delayMs=${delayMs} printLinks=${printLinks}`,
  );
  console.error(`[password-cutover] APP_PUBLIC_URL=${env.appPublicUrl || '(unset)'}`);

  if (dryRun) {
    for (const row of targets) {
      console.error(`  would email ${row.email} (has_password=${row.has_password})`);
    }
    return;
  }

  if (!env.appPublicUrl) {
    throw new Error('APP_PUBLIC_URL must be set so reset links resolve.');
  }
  if (/127\.0\.0\.1|localhost/i.test(env.appPublicUrl)) {
    console.error(
      `[password-cutover] WARNING: APP_PUBLIC_URL is local (${env.appPublicUrl}). Recipients cannot use those links.`,
    );
  }

  if (printLinks) {
    const store = new PostgresAuthStore();
    const lines: string[] = ['email\treset_url'];
    let minted = 0;
    console.error(
      `[password-cutover] minting links ttlSeconds=${env.auth.passwordResetTtlSeconds} (treat as secrets)`,
    );
    for (const row of targets) {
      const email = String(row.email).trim();
      const resetToken = generateOpaqueToken();
      const now = new Date();
      await withTransaction(async (client) => {
        await store.invalidatePasswordResetTokensForUser(row.id, now, client);
        await store.createPasswordResetToken(
          {
            id: randomUUID(),
            userId: row.id,
            tokenHash: hashOpaqueToken(env.auth.tokenSecret, resetToken),
            expiresAt: new Date(
              Date.now() + env.auth.passwordResetTtlSeconds * 1000,
            ),
          },
          client,
        );
      });
      const url = `${env.appPublicUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
      lines.push(`${email}\t${url}`);
      minted += 1;
    }

    const body = `${lines.join('\n')}\n`;
    if (outPath) {
      const absolute = path.resolve(outPath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, body, { mode: 0o600 });
      console.error(`[password-cutover] wrote ${minted} links to ${absolute}`);
    } else {
      process.stdout.write(body);
    }
    console.error(`[password-cutover] done minted=${minted}`);
    return;
  }

  if (env.email.provider === 'unconfigured') {
    throw new Error('EMAIL_PROVIDER must be configured (smtp) before mass reset.');
  }

  const { passwords } = createDefaultAuthLifecycle();
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const row = targets[i]!;
    const email = String(row.email).trim();
    try {
      await passwords.requestPasswordReset(email, {
        ipAddress: '127.0.0.1',
        userAgent: 'password-cutover-script',
      });
      sent += 1;
      console.log(`  sent ${email}`);
    } catch (error) {
      failed += 1;
      console.error(
        `  failed ${email}:`,
        error instanceof Error ? error.message : error,
      );
      if (
        error instanceof EmailDeliveryError &&
        /quota/i.test(error.message)
      ) {
        console.error(
          '[password-cutover] SMTP quota hit. Re-run with --print-links to mint URLs offline, or wait for Resend quota reset.',
        );
        break;
      }
    }

    if (i < targets.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  console.log(`[password-cutover] done sent=${sent} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    if (process.exitCode && process.exitCode !== 0) {
      process.exit(process.exitCode);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
