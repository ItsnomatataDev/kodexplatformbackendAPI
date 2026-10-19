import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from '../src/infrastructure/crypto/secrets.js';
import { ordinaryFixture } from './infrastructure-ordinary-fixture.js';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { createInfrastructureApp } from '../src/infrastructure/app.js';
import { InfrastructureAuth } from '../src/infrastructure/auth/service.js';
import {
  provisionAccount,
  manageAccount,
  registerServer,
} from '../src/infrastructure/auth/provisioning.js';
import { checkDatabaseRole } from '../src/infrastructure/db/pool.js';
import type { InfrastructureConfig } from '../src/infrastructure/config.js';

test(
  'isolated PostgreSQL authentication, concurrency, privilege and failure tests',
  { skip: !process.env.INFRA_TEST_ADMIN_URL },
  async (t) => {
    const admin = new pg.Pool({
      connectionString: process.env.INFRA_TEST_ADMIN_URL,
    });
    const name = `infra_test_${randomBytes(6).toString('hex')}`;
    const runtimeName = `${name}_runtime`,
      provisionName = `${name}_provision`;
    const pass = randomBytes(24).toString('hex');
    const url = new URL(process.env.INFRA_TEST_ADMIN_URL!);
    url.pathname = `/${name}`;
    let owner: pg.Pool | undefined,
      runtime: pg.Pool | undefined,
      provision: pg.Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      owner = new pg.Pool({ connectionString: url.toString() });
      owner.on('error', () => {});
      await owner.query(
        `BEGIN; ${await readFile(new URL('../migrations/0063_infrastructure_authentication.sql', import.meta.url), 'utf8')} COMMIT;`,
      );
      await admin.query(
        `CREATE ROLE ${runtimeName} LOGIN PASSWORD '${pass}' IN ROLE kode_infra_runtime`,
      );
      await admin.query(
        `CREATE ROLE ${provisionName} LOGIN PASSWORD '${pass}' IN ROLE kode_infra_provisioner`,
      );
      // New schema fixtures model existing ordinary application data; runtime must not reach it.
      await owner.query(
        "CREATE SCHEMA ordinary_test; CREATE TABLE ordinary_test.users(secret text); INSERT INTO ordinary_test.users VALUES('ordinary credential')",
      );
      url.username = runtimeName;
      url.password = pass;
      runtime = new pg.Pool({ connectionString: url.toString() });
      runtime.on('error', () => {});
      url.username = provisionName;
      provision = new pg.Pool({ connectionString: url.toString() });
      provision.on('error', () => {});
      let now = new Date();
      const config: InfrastructureConfig = {
        databaseUrl: 'unused',
        host: '127.0.0.1',
        port: 3101,
        origin: 'http://localhost:5173',
        organizationId: randomUUID(),
        tokenKey: randomBytes(32),
        encryptionKeys: { v1: randomBytes(32) },
        activeKeyId: 'v1',
        secure: false,
        idleSeconds: 900,
        absoluteSeconds: 28800,
        freshSeconds: 300,
        challengeSeconds: 300,
        now: () => now,
      };
      const meta = { requestId: randomUUID(), actor: 'operator:test' };
      const app = createInfrastructureApp(config, runtime),
        service = new InfrastructureAuth(runtime, config);
      const password = 'a distinct infrastructure password';
      class Browser {
        cookies = new Map<string, string>();
        csrf = '';
        async request(
          path: string,
          data?: Record<string, string>,
          headers: Record<string, string> = {},
        ) {
          const r = await app.request(`/infrastructure-api${path}`, {
            method: data ? 'POST' : 'GET',
            headers: {
              Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
              ...(data
                ? {
                    'Content-Type': 'application/json',
                    Origin: config.origin,
                    'X-CSRF-Token': this.csrf,
                  }
                : {}),
              ...headers,
            },
            ...(data ? { body: JSON.stringify(data) } : {}),
          });
          for (const cookie of r.headers.getSetCookie()) {
            const [kv] = cookie.split(';');
            const eq = kv.indexOf('=');
            const k = kv.slice(0, eq),
              v = kv.slice(eq + 1);
            if (!v) this.cookies.delete(k);
            else this.cookies.set(k, v);
          }
          return r;
        }
        async refresh() {
          const r = await this.request('/auth/csrf');
          assert.equal(r.status, 200);
          this.csrf = (await r.json()).csrfToken;
        }
        async post(path: string, data: Record<string, string> = {}) {
          await this.refresh();
          return this.request(path, data);
        }
      }
      const token = () => generate({ secret, epoch: now.getTime() / 1000 });
      const tick = () => {
        now = new Date(now.getTime() + 30000);
      };
      let secret = '',
        codes: string[] = [],
        accountId = '';
      const browser = new Browser();
      await t.test(
        'runtime/provisioner are nonowners; ordinary data and audit tampering denied',
        async () => {
          await checkDatabaseRole(runtime!, 'kode_infra_runtime');
          assert.equal((await app.request('/health/ready')).status, 200);
          await checkDatabaseRole(provision!, 'kode_infra_provisioner');
          await assert.rejects(checkDatabaseRole(owner!, 'kode_infra_runtime'));
          for (const sql of [
            "INSERT INTO infrastructure.sessions(account_id,token_hash,auth_version,created_at,last_activity_at,expires_at,authenticated_at) VALUES(gen_random_uuid(),'fake',1,now(),now(),now(),now())",
            "UPDATE infrastructure.sessions SET token_hash='fake'",
            "UPDATE infrastructure.sessions SET expires_at=now()+interval '1 year'",
            'UPDATE infrastructure.sessions SET authenticated_at=now()',
            'UPDATE infrastructure.sessions SET revoked_at=NULL',
            "UPDATE infrastructure.auth_challenges SET purpose='mfa'",
            'SELECT secret_box FROM infrastructure.mfa_credentials',
            'SELECT pending_secret_box FROM infrastructure.auth_challenges',
            'SELECT password_hash FROM infrastructure.accounts',
            'SELECT * FROM infrastructure.recovery_codes',
            "SELECT pg_read_file('/run/secrets/infra_mfa_keys')",
            'GRANT kode_infra_runtime TO CURRENT_USER',
            'SET ROLE kode_infra_owner',
            'SELECT infrastructure.retain_history()',
          ])
            await assert.rejects(provision!.query(sql), { code: '42501' }, sql);
          await assert.rejects(
            runtime!.query(
              'SELECT infrastructure.register_server($1,$2,$3,$4,$5)',
              [config.organizationId, 'bad', 'bad', meta.actor, meta.requestId],
            ),
            { code: '42501' },
          );
          for (const sql of [
            'SELECT * FROM ordinary_test.users',
            'DELETE FROM infrastructure.audit_events',
            "UPDATE infrastructure.audit_events SET action='tamper'",
            "INSERT INTO infrastructure.account_permissions(account_id,permission) VALUES(gen_random_uuid(),'infra.dashboard.read')",
            'CREATE TABLE infrastructure.forbidden(id int)',
          ])
            await assert.rejects(runtime!.query(sql));
        },
      );
      await t.test(
        'actual operator CLI supports the administrative lifecycle without runtime keys',
        async () => {
          const invoke = async (...args: string[]) => {
            const result = await promisify(execFile)(
              process.execPath,
              [
                '--import',
                'tsx',
                'src/cli/infrastructure-accounts.ts',
                ...args,
              ],
              {
                env: {
                  ...process.env,
                  INFRA_PROVISION_DATABASE_URL: url.toString(),
                  INFRA_ORGANIZATION_ID: config.organizationId,
                  INFRA_OPERATOR: 'cli-test',
                  INFRA_TOKEN_KEY_FILE: '/unreadable/session-key',
                  INFRA_MFA_KEYS_FILE: '/unreadable/mfa-key',
                },
              },
            );
            assert.equal(result.stderr, '');
            return JSON.parse(result.stdout);
          };
          const created = await invoke(
            'create',
            'cli@example.test',
            'CLI Test',
            'infra.dashboard.read',
          );
          assert.ok(created.accountId);
          assert.ok(created.capability);
          await invoke(
            'permissions',
            'cli@example.test',
            'infra.dashboard.read,infra.servers.read',
          );
          await invoke('revoke', 'cli@example.test');
          await invoke('disable', 'cli@example.test');
          const reset = await invoke('reset', 'cli@example.test');
          assert.ok(reset.capability);
          const rows = (
            await owner!.query(
              "SELECT action,database_actor FROM infrastructure.audit_events WHERE actor='operator:cli-test'",
            )
          ).rows;
          assert.equal(rows.length, 5);
          assert.ok(rows.every((r) => r.database_actor === provisionName));
        },
      );
      await t.test(
        'ordinary JWTs/cookies and partial challenges grant no infrastructure access; no operations',
        async () => {
          assert.equal(
            (
              await browser.request('/dashboard', undefined, {
                Authorization: 'Bearer ordinary-admin-token',
                Cookie: 'kode_refresh=ordinary; kode_csrf=ordinary',
              })
            ).status,
            401,
          );
          await browser.refresh();
          assert.equal((await browser.request('/dashboard')).status, 401);
          for (const path of [
            '/sql',
            '/terminal',
            '/docker',
            '/database/query',
          ])
            assert.equal((await browser.request(path)).status, 404);
          assert.equal(
            (
              await browser.request(
                '/auth/login',
                { login: 'x', password },
                { Origin: 'https://evil.test' },
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await browser.request(
                '/auth/login',
                { login: 'x', password },
                { 'X-CSRF-Token': '' },
              )
            ).status,
            403,
          );
          assert.equal(
            (await browser.post('/auth/login', { login: 'unknown', password }))
              .status,
            401,
          );
        },
      );
      await t.test(
        'bootstrap one-use; QR restricted; enrollment encrypted and activates only after OTP',
        async () => {
          const result = await provisionAccount(
            provision!,
            config,
            {
              login: 'infra@example.test',
              displayName: 'Test Operator',
              permissions: ['infra.dashboard.read', 'infra.servers.read'],
            },
            meta,
          );
          accountId = result.accountId;
          assert.equal(
            (await browser.post('/auth/enrollment/start', { password })).status,
            401,
          );
          assert.equal(
            (
              await browser.post('/auth/bootstrap/redeem', {
                capability: result.capability,
              })
            ).status,
            200,
          );
          const outsider = new Browser();
          assert.equal(
            (
              await outsider.post('/auth/bootstrap/redeem', {
                capability: result.capability,
              })
            ).status,
            401,
          );
          const r = await browser.post('/auth/enrollment/start', { password });
          assert.equal(r.status, 200);
          secret = new URL((await r.json()).uri).searchParams.get('secret')!;
          assert.equal((await browser.request('/dashboard')).status, 401);
          const complete = await browser.post('/auth/enrollment/confirm', {
            otp: await token(),
          });
          assert.equal(complete.status, 200);
          codes = (await complete.json()).recoveryCodes;
          assert.equal(codes.length, 10);
          const dump = JSON.stringify(
            (await owner!.query('SELECT * FROM infrastructure.mfa_credentials'))
              .rows,
          );
          assert.equal(dump.includes(secret), false);
          assert.equal((await browser.request('/auth/session')).status, 401);
        },
      );
      async function login(b: Browser = browser) {
        const r = await b.post('/auth/login', {
          login: 'infra@example.test',
          password,
        });
        assert.equal(r.status, 200);
        return b;
      }
      await t.test(
        'password-only denied; TOTP replay and concurrent redemption rejected; independent session works',
        async () => {
          await login();
          assert.equal((await browser.request('/dashboard')).status, 401);
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            401,
          );
          tick();
          await browser.refresh();
          const otp = await token();
          const results = await Promise.all([
            browser.request('/auth/mfa/verify', { otp }),
            browser.request('/auth/mfa/verify', { otp }),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
          assert.equal((await browser.request('/dashboard')).status, 200);
          const r = await browser.request('/auth/session');
          assert.equal((await r.json()).mfaVerified, true);
          assert.equal((await browser.request('/servers')).status, 200);
          await registerServer(
            provision!,
            config,
            'Disposable server',
            'test.invalid',
            meta,
          );
          assert.equal(
            (await (await browser.request('/servers')).json()).servers.length,
            1,
          );
        },
      );
      await t.test(
        'real ordinary IT/admin JWTs rejected and logout is independent in both directions',
        async () => {
          for (const role of ['it', 'admin'] as const) {
            const ordinary = await ordinaryFixture(role);
            const headers = { Authorization: ordinary.authorization };
            assert.equal(
              (await ordinary.app.request('/api/me', { headers })).status,
              200,
            );
            const outsider = new Browser();
            assert.equal(
              (
                await outsider.request('/dashboard', undefined, {
                  ...headers,
                  Cookie: `kode_refresh=${ordinary.refreshToken}`,
                })
              ).status,
              401,
            );
            assert.equal((await browser.request('/dashboard')).status, 200);
            const logout = await ordinary.app.request('/auth/logout', {
              method: 'POST',
              headers,
            });
            assert.equal(logout.status, 200);
            assert.equal(
              (await ordinary.app.request('/api/me', { headers })).status,
              401,
            );
            assert.equal((await browser.request('/dashboard')).status, 200);
            const other = await ordinaryFixture(role);
            assert.equal((await browser.post('/auth/logout')).status, 200);
            assert.equal(
              (
                await other.app.request('/api/me', {
                  headers: { Authorization: other.authorization },
                })
              ).status,
              200,
            );
            tick();
            await login();
            assert.equal(
              (await browser.post('/auth/mfa/verify', { otp: await token() }))
                .status,
              200,
            );
          }
        },
      );
      await t.test(
        'invalid MFA is attributed once and shared rate limits survive a second runtime',
        async () => {
          now = new Date(now.getTime() + 901000);
          const pending = await login(new Browser());
          await pending.refresh();
          const before = (
            await owner!.query(
              'SELECT coalesce(sum(occurrences),0)::int n FROM infrastructure.denial_windows WHERE account_id=$1',
              [accountId],
            )
          ).rows[0].n;
          for (let i = 0; i < 10; i++) {
            const r = await pending.request('/auth/mfa/verify', {
              otp: 'invalid',
            });
            assert.equal(r.status, i < 8 ? 401 : 429);
          }
          const after = (
            await owner!.query(
              'SELECT coalesce(sum(occurrences),0)::int n FROM infrastructure.denial_windows WHERE account_id=$1',
              [accountId],
            )
          ).rows[0].n;
          assert.equal(after - before, 10); // No duplicate catch + HTTP denial.
          const second = new InfrastructureAuth(runtime!, config);
          await service.limit([{ key: 'replica-key', limit: 1 }], meta);
          await assert.rejects(
            second.limit([{ key: 'replica-key', limit: 1 }], meta),
          );
          now = new Date(now.getTime() + 901000);
          tick();
          await login();
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
        },
      );
      await t.test(
        'different MFA challenges cannot redeem the same OTP; logout-all revokes distinct sessions',
        async () => {
          tick();
          const first = await login(new Browser());
          const second = await login(new Browser());
          const otp = await token();
          const results = await Promise.all([
            first.post('/auth/mfa/verify', { otp }),
            second.post('/auth/mfa/verify', { otp }),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
          const winner = results[0].status === 200 ? first : second;
          const loser = results[0].status === 200 ? second : first;
          tick();
          assert.equal(
            (await loser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
          assert.notEqual(
            winner.cookies.get('kodex_infra_dev_session'),
            loser.cookies.get('kodex_infra_dev_session'),
          );
          // A CSRF proof from a separate session cannot authorize the other session.
          await winner.refresh();
          await loser.refresh();
          assert.equal(
            (
              await loser.request(
                '/auth/logout',
                {},
                { 'X-CSRF-Token': winner.csrf },
              )
            ).status,
            403,
          );
          assert.equal((await winner.post('/auth/logout-all')).status, 200);
          assert.equal((await loser.request('/dashboard')).status, 401);
          assert.equal((await browser.request('/dashboard')).status, 401);
          tick();
          await login();
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
        },
      );
      await t.test(
        'polling does not extend idle lifetime; activity is explicit; fresh-auth rotates and logout invalidates copies',
        async () => {
          const old = browser.cookies.get('kodex_infra_dev_session');
          now = new Date(now.getTime() + 301000);
          assert.equal((await browser.post('/auth/logout-all')).status, 403);
          tick();
          assert.equal(
            (
              await browser.post('/auth/reauthenticate', {
                password,
                otp: await token(),
              })
            ).status,
            200,
          );
          assert.notEqual(browser.cookies.get('kodex_infra_dev_session'), old);
          assert.equal(await service.session(old!), null);
          assert.equal((await browser.post('/auth/activity')).status, 200);
          const before = (await (await browser.request('/auth/session')).json())
            .idleExpiresAt;
          now = new Date(now.getTime() + 1000);
          assert.equal(
            (await (await browser.request('/auth/session')).json())
              .idleExpiresAt,
            before,
          );
          const copied = new Browser();
          copied.cookies = new Map(browser.cookies);
          assert.equal((await browser.post('/auth/logout')).status, 200);
          assert.equal((await copied.request('/dashboard')).status, 401);
        },
      );
      await t.test(
        'recovery codes are one-use and only authorize MFA replacement',
        async () => {
          await login();
          const other = await login(new Browser());
          const [a, b] = await Promise.all([
            browser.post('/auth/recovery/verify', { code: codes[0] }),
            other.post('/auth/recovery/verify', { code: codes[0] }),
          ]);
          assert.deepEqual([a.status, b.status].sort(), [200, 401]);
          const recovered = a.status === 200 ? browser : other;
          assert.equal((await recovered.request('/dashboard')).status, 401);
          assert.equal(
            (
              await recovered.post('/auth/enrollment/start', {
                password: 'not the current password',
              })
            ).status,
            401,
          );
          const r = await recovered.post('/auth/enrollment/start', {
            password,
          });
          assert.equal(r.status, 200);
          secret = new URL((await r.json()).uri).searchParams.get('secret')!;
          const done = await recovered.post('/auth/enrollment/confirm', {
            otp: await token(),
          });
          assert.equal(done.status, 200);
          assert.equal((await recovered.request('/auth/session')).status, 401);
        },
      );

      await t.test(
        'idle/absolute expiry, expired challenge and audit rollback at session issuance',
        async () => {
          now = new Date(now.getTime() + 901000);
          tick();
          await login();
          await owner!.query(
            'REVOKE INSERT ON infrastructure.audit_events FROM kode_infra_runtime',
          );
          const before = (
            await owner!.query(
              'SELECT count(*)::int n FROM infrastructure.sessions',
            )
          ).rows[0].n;
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            503,
          );
          assert.equal(
            (
              await owner!.query(
                'SELECT count(*)::int n FROM infrastructure.sessions',
              )
            ).rows[0].n,
            before,
          );
          await owner!.query(
            'GRANT INSERT ON infrastructure.audit_events TO kode_infra_runtime',
          );
          // The failed transaction must not burn the OTP or consume the challenge.
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
          const response = await browser.request('/auth/session');
          const text = await response.text();
          for (const value of [
            password,
            secret,
            codes[0],
            browser.cookies.get('kodex_infra_dev_session')!,
          ])
            assert.equal(text.includes(value), false);
          now = new Date(now.getTime() + 900000);
          assert.equal((await browser.request('/dashboard')).status, 401);
          tick();
          await login();
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
          now = new Date(now.getTime() + 28800000);
          // Keep idle timestamp current to isolate absolute-expiry enforcement.
          await owner!.query(
            'UPDATE infrastructure.sessions SET last_activity_at=$1',
            [now],
          );
          assert.equal((await browser.request('/dashboard')).status, 401);
          await login();
          now = new Date(now.getTime() + 300000);
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            401,
          );
        },
      );

      await t.test(
        'routine MFA replacement requires password plus a fresh OTP and revokes existing sessions',
        async () => {
          tick();
          await login();
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
          assert.equal(
            (
              await browser.post('/auth/mfa/replace', {
                password: 'wrong',
                otp: await token(),
              })
            ).status,
            401,
          );
          const old = browser.cookies.get('kodex_infra_dev_session')!;
          tick();
          assert.equal(
            (
              await browser.post('/auth/mfa/replace', {
                password,
                otp: await token(),
              })
            ).status,
            200,
          );
          assert.equal(await service.session(old), null);
          assert.equal((await browser.request('/dashboard')).status, 401);
          const r = await browser.post('/auth/enrollment/start', { password });
          assert.equal(r.status, 200);
          secret = new URL((await r.json()).uri).searchParams.get('secret')!;
          assert.equal(
            (
              await browser.post('/auth/enrollment/confirm', {
                otp: await token(),
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        'account/permission changes invalidate current sessions on next request',
        async () => {
          tick();
          await login();
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
          await manageAccount(
            provision!,
            config,
            'infra@example.test',
            'permissions',
            meta,
            ['infra.dashboard.read'],
          );
          assert.equal((await browser.request('/dashboard')).status, 401);
          tick();
          await login();
          assert.equal(
            (await browser.post('/auth/mfa/verify', { otp: await token() }))
              .status,
            200,
          );
          assert.equal((await browser.request('/servers')).status, 403);
          const auditRow = (
            await owner!.query(
              "SELECT * FROM infrastructure.audit_events WHERE action='account.permissions' ORDER BY created_at DESC LIMIT 1",
            )
          ).rows[0];
          assert.deepEqual(auditRow.previous_permissions, [
            'infra.dashboard.read',
            'infra.servers.read',
          ]);
          assert.deepEqual(auditRow.new_permissions, ['infra.dashboard.read']);
          assert.deepEqual(auditRow.added_permissions, []);
          assert.deepEqual(auditRow.removed_permissions, [
            'infra.servers.read',
          ]);
          assert.equal(auditRow.actor, meta.actor);
          assert.equal(auditRow.database_actor, provisionName);
          assert.equal(auditRow.account_id, accountId);
          assert.equal(auditRow.reason, 'operator_requested');
          const serverEvent = (
            await owner!.query(
              "SELECT * FROM infrastructure.audit_events WHERE action='server.registered'",
            )
          ).rows[0];
          assert.equal(serverEvent.organization_id, config.organizationId);
          assert.ok(
            (
              await owner!.query(
                'SELECT id FROM infrastructure.servers WHERE id=$1',
                [serverEvent.object_id],
              )
            ).rowCount,
          );
          await manageAccount(
            provision!,
            config,
            'infra@example.test',
            'revoke',
            meta,
          );
          assert.equal((await browser.request('/dashboard')).status, 401);
          await manageAccount(
            provision!,
            config,
            'infra@example.test',
            'disable',
            meta,
          );
          assert.equal((await browser.request('/dashboard')).status, 401);
          assert.equal(
            (
              await browser.post('/auth/login', {
                login: 'infra@example.test',
                password,
              })
            ).status,
            401,
          );
        },
      );

      await t.test(
        'controlled reset revokes authority, expired bootstrap fails and lockout expires',
        async () => {
          const reset = await manageAccount(
            provision!,
            config,
            'infra@example.test',
            'reset',
            meta,
          );
          assert.ok(reset.capability);
          assert.equal((await browser.request('/dashboard')).status, 401);
          const pending = new Browser();
          assert.equal(
            (
              await pending.post('/auth/login', {
                login: 'infra@example.test',
                password,
              })
            ).status,
            401,
          );
          now = new Date(now.getTime() + 901000);
          assert.equal(
            (
              await pending.post('/auth/bootstrap/redeem', {
                capability: reset.capability!,
              })
            ).status,
            401,
          );
          await service.limit([{ key: 'temporary-lockout', limit: 1 }], meta);
          await assert.rejects(
            service.limit([{ key: 'temporary-lockout', limit: 1 }], meta),
          );
          now = new Date(now.getTime() + 901000);
          await service.limit([{ key: 'temporary-lockout', limit: 1 }], meta);
          const rows = (
            await owner!.query(
              'SELECT password_hash,status FROM infrastructure.accounts WHERE id=$1',
              [accountId],
            )
          ).rows;
          assert.equal(rows[0].password_hash, null);
          assert.equal(rows[0].status, 'pending');
        },
      );
      await t.test(
        'audit failure rolls back provisioning; bounded failures throttle and unavailable DB fails closed',
        async () => {
          await owner!.query(
            "ALTER TABLE infrastructure.audit_events ADD CONSTRAINT test_audit_failure CHECK(action <> 'account.provisioned') NOT VALID",
          );
          await assert.rejects(
            provisionAccount(
              provision!,
              config,
              {
                login: 'rollback',
                displayName: 'Rollback',
                permissions: ['infra.dashboard.read'],
              },
              meta,
            ),
          );
          assert.equal(
            (
              await owner!.query(
                "SELECT count(*)::int n FROM infrastructure.accounts WHERE login='rollback'",
              )
            ).rows[0].n,
            0,
          );
          await owner!.query(
            'ALTER TABLE infrastructure.audit_events DROP CONSTRAINT test_audit_failure',
          );
          await service.limit([{ key: 'bounded', limit: 1 }], meta);
          await assert.rejects(
            service.limit([{ key: 'bounded', limit: 1 }], meta),
          );
          const audit = JSON.stringify(
            (await owner!.query('SELECT * FROM infrastructure.audit_events'))
              .rows,
          );
          for (const sensitive of [password, secret, codes[0]])
            assert.equal(audit.includes(sensitive), false);
          await owner!.query(
            'REVOKE EXECUTE ON FUNCTION infrastructure.record_denial(text,text,uuid,uuid) FROM kode_infra_runtime',
          );
          const b = new Browser();
          assert.equal(
            (await b.post('/auth/login', { login: 'unknown', password }))
              .status,
            503,
          );
          await owner!.query(
            'GRANT EXECUTE ON FUNCTION infrastructure.record_denial(text,text,uuid,uuid) TO kode_infra_runtime',
          );
        },
      );

      await t.test(
        'only exact trusted socket peers may supply forwarded client identity',
        async () => {
          const trusted = createInfrastructureApp(
            { ...config, trustedProxyIps: ['127.0.0.1'] },
            runtime!,
          );
          for (const [peer, forwarded, expected] of [
            ['127.0.0.1', '198.51.100.81', '198.51.100.81'],
            ['192.0.2.1', '198.51.100.82', '192.0.2.1'],
            ['127.0.0.1', 'not-an-ip', '127.0.0.1'],
          ]) {
            const request = await trusted.request(
              '/infrastructure-api/dashboard',
              {
                headers: {
                  'X-Infra-Client-IP': forwarded,
                  'X-Forwarded-For': '203.0.113.99',
                },
              },
              {
                incoming: {
                  socket: { remoteAddress: peer },
                } as import('node:http').IncomingMessage,
              },
            );
            assert.equal(request.status, 401);
            const row = (
              await owner!.query(
                'SELECT actor FROM infrastructure.denial_windows WHERE last_request_id=$1',
                [request.headers.get('X-Request-ID')],
              )
            ).rows[0];
            assert.equal(row.actor, `http:${expected}:unknown`);
          }
        },
      );
      await t.test(
        'bounded flood aggregation, trusted peer identity, replica sharing and retention',
        async () => {
          now = new Date(now.getTime() + 60000);
          const first = createInfrastructureApp(config, runtime!);
          const second = createInfrastructureApp(config, runtime!);
          await owner!.query('TRUNCATE infrastructure.denial_windows');
          const captured: string[] = [];
          const original = console.info;
          console.info = (...args: unknown[]) => {
            captured.push(args.join(' '));
          };
          try {
            for (let i = 0; i < 400; i++) {
              const app = i % 2 ? first : second;
              const r = await app.request('/infrastructure-api/auth/login', {
                method: 'POST',
                headers: {
                  Origin: 'https://evil.test',
                  'X-Infra-Client-IP': `198.51.100.${i % 255}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  password,
                  otp: '123456',
                  code: codes[0],
                }),
              });
              assert.equal(r.status, i < 240 ? 403 : 429);
            }
            const rows = (
              await owner!.query('SELECT * FROM infrastructure.denial_windows')
            ).rows;
            // Database windows use wall time; do not assume a test cannot cross a minute.
            const windows = new Set(
              rows.map((r) => r.window_start.toISOString()),
            );
            assert.ok(rows.length <= 2 * windows.size);
            const count = (reason: string) =>
              rows
                .filter((r) => r.reason === reason)
                .reduce((n, r) => n + Number(r.occurrences), 0);
            assert.equal(count('forbidden'), 240);
            assert.equal(count('ingress_limited'), 2);
            assert.ok(rows.every((r) => r.actor === 'http:local:unknown'));
            // A real expired session is distinct from missing/forged-cookie coverage.
            const expiredAccount = await provisionAccount(
              provision!,
              config,
              {
                login: 'expired@example.test',
                displayName: 'Expired',
                permissions: ['infra.dashboard.read'],
              },
              meta,
            );
            const expiredToken = 'expired-disposable-session';
            await owner!.query(
              "UPDATE infrastructure.accounts SET status='active' WHERE id=$1",
              [expiredAccount.accountId],
            );
            await owner!.query(
              `INSERT INTO infrastructure.sessions(account_id,token_hash,auth_version,created_at,last_activity_at,expires_at,authenticated_at)
            VALUES($1,$2,1,$3,$3,$4,$3)`,
              [
                expiredAccount.accountId,
                digest(config, 'session', expiredToken),
                now,
                new Date(now.getTime() - 1),
              ],
            );
            // Reset a minute and exercise missing and expired cookies, invalid CSRF.
            now = new Date(now.getTime() + 60000);
            for (let i = 0; i < 150; i++) {
              const r = await first.request('/infrastructure-api/dashboard', {
                headers: { Cookie: `kodex_infra_dev_session=${expiredToken}` },
              });
              assert.equal(r.status, i < 120 ? 401 : 429);
            }
            now = new Date(now.getTime() + 60000);
            for (let i = 0; i < 150; i++) {
              const r = await first.request('/infrastructure-api/dashboard');
              assert.equal(r.status, i < 120 ? 401 : 429);
            }
            now = new Date(now.getTime() + 60000);
            for (let i = 0; i < 150; i++) {
              const r = await first.request(
                '/infrastructure-api/auth/mfa/verify',
                {
                  method: 'POST',
                  headers: {
                    Origin: config.origin,
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': 'wrong',
                  },
                  body: '{}',
                },
              );
              assert.equal(r.status, i < 120 ? 403 : 429);
            }
            const growth = (
              await owner!.query(
                'SELECT window_start,count(*)::int n FROM infrastructure.denial_windows GROUP BY window_start',
              )
            ).rows;
            assert.ok(growth.every((r) => r.n <= 5));
            t.diagnostic(
              `850 invalid requests: ${growth.reduce((n, r) => n + r.n, 0)} denial rows across ${growth.length} database minute(s); 250 ingress rejections`,
            );
            // Unique identities cannot produce more than 100 details + five overflow reasons per DB minute.
            for (let i = 0; i < 200; i++)
              await service.denied(
                { requestId: randomUUID(), actor: `http:198.51.100.${i}` },
                'forbidden',
              );
            assert.ok(
              (
                await owner!.query(
                  'SELECT count(*)::int n FROM infrastructure.denial_windows GROUP BY window_start ORDER BY n DESC LIMIT 1',
                )
              ).rows[0].n <= 105,
            );
            // Retention cannot be invoked by either service identity.
            await assert.rejects(
              runtime!.query('SELECT infrastructure.retain_history()'),
              { code: '42501' },
            );
            await owner!.query(
              "UPDATE infrastructure.denial_windows SET window_start=window_start-interval '91 days'",
            );
            await owner!.query(
              "INSERT INTO infrastructure.audit_events(action,successful,actor,request_id,created_at) VALUES('old',true,'operator:test',$1,now()-interval '366 days')",
              [randomUUID()],
            );
            await owner!.query('SELECT infrastructure.retain_history()');
            assert.equal(
              (
                await owner!.query(
                  'SELECT count(*)::int n FROM infrastructure.denial_windows',
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (
                await owner!.query(
                  "SELECT count(*)::int n FROM infrastructure.audit_events WHERE action='old'",
                )
              ).rows[0].n,
              0,
            );
            for (const value of [password, secret, codes[0], '123456'])
              assert.equal(captured.join('').includes(value), false);
          } finally {
            console.info = original;
          }
        },
      );
      await t.test(
        'secure cookies and unavailable authentication database fail closed',
        async () => {
          const secureApp = createInfrastructureApp(
            { ...config, secure: true, origin: 'https://infra.example.test' },
            runtime!,
          );
          const r = await secureApp.request('/infrastructure-api/auth/csrf');
          assert.equal(r.status, 200);
          const cookie = r.headers
            .getSetCookie()
            .find((v) => v.startsWith('__Host-kodex_infra_challenge='))!;
          assert.match(cookie, /HttpOnly/);
          assert.match(cookie, /Secure/);
          assert.match(cookie, /SameSite=Strict/);
          assert.match(cookie, /Path=\//);
          assert.doesNotMatch(cookie, /Domain=/);
          const dead = new pg.Pool({ connectionString: url.toString() });
          await dead.end();
          const unavailable = createInfrastructureApp(config, dead);
          assert.equal(
            (await unavailable.request('/infrastructure-api/auth/session'))
              .status,
            503,
          );
          assert.equal(
            (await unavailable.request('/health/ready')).status,
            503,
          );
          assert.equal((await unavailable.request('/health/live')).status, 200);
        },
      );
    } finally {
      await runtime?.end();
      await provision?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeName}`);
      await admin.query(`DROP ROLE IF EXISTS ${provisionName}`);
      await admin.end();
    }
  },
);
