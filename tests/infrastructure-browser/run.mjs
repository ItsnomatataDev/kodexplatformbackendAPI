/** Opt-in local end-to-end test; creates and destroys its own database and login roles. */
import pg from 'pg';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { generate } from 'otplib';
import { chromium } from 'playwright';
import { createInfrastructureApp } from '../../src/infrastructure/app.ts';
import {
  provisionAccount,
  registerServer,
  manageAccount,
} from '../../src/infrastructure/auth/provisioning.ts';

if (!process.env.INFRA_TEST_ADMIN_URL)
  throw new Error(
    'Set INFRA_TEST_ADMIN_URL to a disposable local PostgreSQL administrator connection',
  );
const admin = new pg.Pool({
  connectionString: process.env.INFRA_TEST_ADMIN_URL,
});
const name = `infra_browser_${randomBytes(5).toString('hex')}`,
  runtimeName = `${name}_rt`,
  provisionName = `${name}_op`,
  pass = randomBytes(24).toString('hex');
const url = new URL(process.env.INFRA_TEST_ADMIN_URL);
url.pathname = `/${name}`;
let owner, runtime, provision, browser;
let server, vite;
try {
  await admin.query(`CREATE DATABASE ${name}`);
  owner = new pg.Pool({ connectionString: url.toString() });
  owner.on('error', () => {});
  await owner.query(
    `BEGIN;${await readFile(new URL('../../migrations/0063_infrastructure_authentication.sql', import.meta.url), 'utf8')}COMMIT;`,
  );
  await admin.query(
    `CREATE ROLE ${runtimeName} LOGIN PASSWORD '${pass}' IN ROLE kode_infra_runtime`,
  );
  await admin.query(
    `CREATE ROLE ${provisionName} LOGIN PASSWORD '${pass}' IN ROLE kode_infra_provisioner`,
  );
  url.username = runtimeName;
  url.password = pass;
  runtime = new pg.Pool({ connectionString: url.toString() });
  runtime.on('error', () => {});
  url.username = provisionName;
  provision = new pg.Pool({ connectionString: url.toString() });
  provision.on('error', () => {});
  let offset = 0;
  const config = {
    databaseUrl: 'unused',
    host: '127.0.0.1',
    port: 3101,
    origin: 'http://127.0.0.1:5179',
    organizationId: randomUUID(),
    tokenKey: randomBytes(32),
    encryptionKeys: { v1: randomBytes(32) },
    activeKeyId: 'v1',
    secure: false,
    idleSeconds: 900,
    absoluteSeconds: 28800,
    freshSeconds: 300,
    challengeSeconds: 300,
    now: () => new Date(Date.now() + offset),
  };
  const meta = { requestId: randomUUID(), actor: 'operator:browser-test' };
  const issued = await provisionAccount(
    provision,
    config,
    {
      login: 'browser@example.test',
      displayName: 'Local Test Administrator',
      permissions: ['infra.dashboard.read', 'infra.servers.read'],
    },
    meta,
  );
  await registerServer(
    provision,
    config,
    'Disposable development server',
    'test.invalid',
    meta,
  );
  server = serve({
    fetch: createInfrastructureApp(config, runtime).fetch,
    hostname: '127.0.0.1',
    port: 3101,
  });
  const front =
    process.env.INFRA_TEST_FRONTEND_DIR ??
    new URL('../../../ITsNomatataWorkSpace', import.meta.url).pathname;
  vite = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      '5179',
      '--strictPort',
    ],
    { cwd: front, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let spawnError;
  vite.on('error', (e) => {
    spawnError = e;
  });
  vite.stdout?.resume();
  vite.stderr?.resume();
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (spawnError) throw spawnError;
    if (vite.exitCode !== null) throw new Error('Local Vite server exited');
    try {
      if ((await fetch(config.origin)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  if (!ready) throw new Error('Local Vite server did not become ready');
  browser = await chromium.launch({
    headless: true,
    ...(process.env.INFRA_TEST_CHROME_PATH
      ? { executablePath: process.env.INFRA_TEST_CHROME_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost'
      ? route.continue()
      : route.abort();
  });
  const page = await context.newPage();
  const crashes = [];
  const browserLogs = [];
  page.on('console', (message) => browserLogs.push(message.text()));
  page.on('pageerror', (e) => crashes.push(e.message));
  await page.goto(`${config.origin}/it/infrastructure`);
  await page.getByRole('heading', { name: 'Infrastructure sign in' }).waitFor();
  assert.equal(page.url(), `${config.origin}/it/infrastructure/login`);
  await page.goto(`${config.origin}/it/infrastructure/verify`);
  await page.getByRole('heading', { name: 'Infrastructure sign in' }).waitFor();
  await page
    .getByRole('link', { name: 'Have an enrollment capability?' })
    .click();
  await page.getByLabel('Enrollment capability').fill(issued.capability);
  await page
    .getByRole('button', { name: 'Redeem capability', exact: true })
    .click();
  await page.getByLabel('New infrastructure password').waitFor();
  const password = 'local browser test distinct password';
  await page.getByLabel('New infrastructure password').fill(password);
  await page
    .getByRole('button', { name: 'Set up authenticator', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Connect your authenticator' })
    .waitFor();
  await page.getByText('Enter a setup key manually', { exact: true }).click();
  let secret = (await page.locator('details p').innerText()).trim();
  const sensitive = [password, issued.capability, secret];
  await page
    .getByLabel('Authenticator code', { exact: true })
    .fill(await generate({ secret, epoch: config.now().getTime() / 1000 }));
  await page
    .getByRole('button', { name: 'Confirm authenticator', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Save your recovery codes' })
    .waitFor();
  assert.equal(await page.locator('main li').count(), 10);
  const recoveryCodes = await page.locator('main li').allTextContents();
  sensitive.push(...recoveryCodes);
  await page.getByLabel('I have saved my recovery codes').check();
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await page
    .getByLabel('Infrastructure login', { exact: true })
    .fill('browser@example.test');
  await page
    .getByLabel('Infrastructure password', { exact: true })
    .fill(password);
  await page.getByRole('button', { name: 'Continue to verification' }).click();
  await page.getByRole('heading', { name: 'Verify your identity' }).waitFor();
  assert.equal(
    (
      await context.request.get(`${config.origin}/infrastructure-api/dashboard`)
    ).status(),
    401,
  );
  offset += 60000;
  await page
    .getByLabel('Authenticator code', { exact: true })
    .fill(await generate({ secret, epoch: config.now().getTime() / 1000 }));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page
    .getByRole('heading', { name: 'Control Center', exact: true })
    .waitFor();
  await page
    .getByText('Disposable development server', { exact: true })
    .waitFor();
  await mkdir('/tmp/kodex-infrastructure-verification', { recursive: true });
  await page.screenshot({
    path: '/tmp/kodex-infrastructure-verification/desktop.png',
    fullPage: true,
  });
  assert.equal(
    (await context.cookies()).some((c) => c.name === 'kode_refresh'),
    false,
  );
  const second = await context.newPage();
  await second.goto(`${config.origin}/it/infrastructure`);
  await second
    .getByRole('heading', { name: 'Control Center', exact: true })
    .waitFor();
  await page.getByRole('link', { name: 'SQL Editor', exact: true }).click();
  await page
    .getByText('Not implemented in Phase 1.', { exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: 'Toggle infrastructure navigation' })
    .click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Control Center', exact: true })
    .waitFor();
  await page.screenshot({
    path: '/tmp/kodex-infrastructure-verification/mobile.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Infrastructure sign in' }).waitFor();
  await second
    .getByRole('heading', { name: 'Infrastructure sign in' })
    .waitFor();
  assert.equal(
    (
      await context.request.get(`${config.origin}/infrastructure-api/dashboard`)
    ).status(),
    401,
  );
  async function passwordLogin() {
    offset += 60000;
    await page
      .getByLabel('Infrastructure login', { exact: true })
      .fill('browser@example.test');
    await page
      .getByLabel('Infrastructure password', { exact: true })
      .fill(password);
    await page
      .getByRole('button', { name: 'Continue to verification' })
      .click();
    await page.getByRole('heading', { name: 'Verify your identity' }).waitFor();
  }
  async function finishMfa() {
    const otp = await generate({
      secret,
      epoch: config.now().getTime() / 1000,
    });
    sensitive.push(otp);
    await page.getByLabel('Authenticator code', { exact: true }).fill(otp);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await page
      .getByRole('heading', { name: 'Control Center', exact: true })
      .waitFor();
  }
  await passwordLogin();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page
    .getByLabel('Recovery code', { exact: true })
    .fill(recoveryCodes[0]);
  const [recoveryResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
        '/infrastructure-api/auth/recovery/verify',
    ),
    page.getByRole('button', { name: 'Begin recovery' }).click(),
  ]);
  assert.equal(recoveryResponse.status(), 200, await recoveryResponse.text());
  await page
    .getByLabel('Current infrastructure password')
    .waitFor({ timeout: 5000 })
    .catch(async () => {
      throw new Error(
        `Recovery navigation: ${new URL(page.url()).pathname}; headings: ${await page.locator('h1,h2').allTextContents()}`,
      );
    });
  assert.equal(
    (
      await context.request.get(`${config.origin}/infrastructure-api/dashboard`)
    ).status(),
    401,
  );
  await page.getByLabel('Current infrastructure password').fill(password);
  await page
    .getByRole('button', { name: 'Set up authenticator', exact: true })
    .click();
  await page.getByText('Enter a setup key manually', { exact: true }).click();
  secret = (await page.locator('details p').innerText()).trim();
  sensitive.push(secret);
  await page
    .getByLabel('Authenticator code', { exact: true })
    .fill(await generate({ secret, epoch: config.now().getTime() / 1000 }));
  await page
    .getByRole('button', { name: 'Confirm authenticator', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Save your recovery codes' })
    .waitFor();
  await page.getByLabel('I have saved my recovery codes').check();
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await passwordLogin();
  await finishMfa();
  offset += 901000;
  await page.reload();
  await page.getByRole('heading', { name: 'Infrastructure sign in' }).waitFor();
  await passwordLogin();
  await finishMfa();
  await manageAccount(
    provision,
    config,
    'browser@example.test',
    'revoke',
    meta,
  );
  await page.reload();
  await page.getByRole('heading', { name: 'Infrastructure sign in' }).waitFor();
  for (const value of sensitive)
    assert.equal(browserLogs.join('\n').includes(value), false);
  await page.getByRole('link', { name: 'Back to Kodex' }).click();
  await page.waitForURL(`${config.origin}/login`);
  await page.locator('input[type="password"]').waitFor();
  assert.deepEqual(crashes, []);
  console.log(
    'PASS: signed-out route guard, restricted MFA route, bootstrap enrollment, QR, recovery-code receipt, password+MFA login, metadata, mobile shell, unavailable module, cross-tab logout, recovery and re-enrollment, idle expiry, operator revocation, secret-free browser logs, ordinary login navigation',
  );
  console.log(
    'Screenshots: /tmp/kodex-infrastructure-verification/{desktop,mobile}.png',
  );
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) {
    vite.kill('SIGTERM');
    await once(vite, 'exit').catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  await runtime?.end();
  await provision?.end();
  await owner?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${runtimeName}`);
  await admin.query(`DROP ROLE IF EXISTS ${provisionName}`);
  await admin.end();
}
