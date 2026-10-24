# Kodex Infrastructure Control Center — Stage B implementation

Implemented locally on 2026-10-10 in the existing `kode-platform` and `ITsNomatataWorkSpace` repositories. This is the independent authentication milestone; operational infrastructure modules remain unavailable. No production deployment, container restart, production migration, account provisioning, network change or credential change was performed. Existing unrelated working-tree edits were preserved.

> Updated by [Stage B.1 hardening and verification](infrastructure-control-center-stage-b1.md) on 2026-10-11. That report supersedes the initial privilege, denial-audit, provisioning configuration and release-readiness details below. No deployment is authorized.

## What is implemented

The dedicated Hono entrypoint is `src/infrastructure/server.ts`. It imports only infrastructure configuration, its own PostgreSQL pool and its own app. It never imports ordinary `src/app.ts`, ordinary authentication, schedulers, media workers or Redis chat. Docker has an opt-in non-root `infrastructure` build target; `api` remains the default final target. Ordinary API startup has no new required environment variables.

Authentication uses independent accounts, Argon2id passwords (15–128 characters, no trimming), encrypted TOTP via pinned `otplib@13.5.0`, one-use bootstrap capabilities, recovery codes and opaque sessions. AES-256-GCM uses an account-bound associated-data value and a key ID; HMAC-SHA256 purpose-separates session, challenge, recovery, throttle and CSRF digests. Bootstrap capabilities use domain-separated SHA-256 so the provisioner needs no runtime keys. Random capabilities/tokens/codes contain 256 bits of entropy. Plaintext passwords, MFA secrets, recovery codes and cookies are not persisted. QR/setup material and recovery codes are returned only at their authorized enrollment step and kept in UI memory.

Enrollment requires an operator-issued capability valid for 15 minutes, followed by a five-minute restricted challenge. Password and encrypted pending MFA secret are stored in the challenge. First TOTP confirmation activates the account, atomically replaces credentials and recovery codes, consumes challenges and revokes old sessions. It returns ten recovery codes once and requires a fresh password+MFA login. The enrollment OTP is already consumed: wait for a fresh authenticator code before logging in.

Password login creates only a five-minute MFA challenge. OTP acceptance advances a locked per-account counter; concurrent/repeated use cannot issue multiple sessions. Verification accepts six digits with a 30-second time step and at most one adjacent step. Recovery requires a password-verified challenge and a one-use code. It grants only re-enrollment authority, never dashboard access. Routine replacement requires the existing password and a fresh OTP, revokes sessions and issues a restricted replacement challenge. Out-of-band loss-of-both-factors recovery is an audited operator reset.

Sessions use Secure, HttpOnly, host-only `__Host-kodex_infra_session` cookies, Path=/, SameSite=Strict; challenges use `__Host-kodex_infra_challenge`. Explicit loopback-only HTTP development uses separately named `kodex_infra_dev_*` cookies. Every mutation checks exact Origin, JSON content type and a server-bound CSRF token, including enrollment and login. There is no ordinary bearer-token fallback, JWT permission cache, localStorage credential storage or ordinary-admin bypass.

Server-enforced defaults are 15-minute idle, eight-hour absolute and five-minute fresh-auth lifetimes. Reads/polling do not renew idle time. A throttled browser activity handler calls a dedicated mutation on trusted user interaction. Session polling, focus checks and a BroadcastChannel update other tabs. Reauthentication rotates the opaque token. Disable, permission changes, reset and explicit revocation invalidate sessions server-side; ordinary and infrastructure logout remain independent.

Initial permissions are exactly `infra.dashboard.read` and `infra.servers.read`. Self-session controls require the authenticated session, not an operational grant. Reserved database, Docker, terminal, file and security permissions cannot be provisioned or used. Server registration is an explicit operator action and only stores organization-scoped label/address metadata. No migration seeds a production server or account.

## Schema and privilege boundary

`migrations/0063_infrastructure_authentication.sql` creates the `infrastructure` schema and eleven tables (including the B.1 denial_windows aggregates): accounts, account_permissions, bootstrap_tokens, mfa_credentials, recovery_codes, auth_challenges, sessions, authentication_attempts, audit_events and servers. UUID keys, account foreign keys, unique digests/login/permission constraints and throttle/session/audit indexes are included.

The migration owner is `kode_infra_owner` (NOLOGIN). Separate NOLOGIN groups `kode_infra_runtime` and `kode_infra_provisioner` receive explicit grants on new objects only. Runtime cannot create accounts, grant permissions, register servers, or read/update/delete audit events; it can insert audits. The provisioner can create/manage accounts and register metadata, but cannot create full sessions. Public privileges on the new schema/tables and default function execution are removed. Existing schema grants and ordinary roles are unchanged. Runtime and CLI startup reject elevated roles, owner membership, database ownership and cross-membership in the other infrastructure group. Queries are schema-qualified; the pool pins `search_path=pg_catalog`.

Migration 0063 is additive and was tested in newly created disposable local databases. **Do not run every pending local migration against production.** Production's earlier 0061 ledger gap remains a separate release issue. An approved deployment must inspect its ledger and apply precisely the reviewed migration through a transaction; do not rewrite old ledger entries or manufacture placeholders. Review examples live in `deploy/infrastructure/` and are not live deployment configuration.

## Abuse controls and audit

The implementation uses shared PostgreSQL throttles rather than the proposed Redis limiter: committed attempt records and transaction advisory locks make limits durable across processes, and database failure closes authentication. No Redis connection or Redis secrets are loaded. Current starting limits are 100 attempts per trusted peer, 10 per normalized login, 30 per account identity, and eight per challenge in 15 minutes. These count attempted authentication/enrollment transitions, including successful ones. Keys are HMACs. Bounds are applied before expensive hashing; Argon2 work has a separate two-operation concurrency cap. Pool size is five with bounded connection, statement and idle-transaction timeouts. Load-test these defaults before real use.

Argon2id parameters are 19 MiB, two iterations, parallelism one, 32-byte hash. Local authentication tests measure functionality, not production capacity or password-cracking resistance benchmarks. Review and benchmark on the approved host before deployment.

Audit rows have explicit columns and controlled action/reason values; no generic metadata/body serialization exists. Successful provisioning, authentication, MFA/recovery and revocation transitions commit with their audit event. Audit failure prevents issuing authority. Denials are separately recorded. HTTP actor IP comes from the socket unless that exact peer is explicitly trusted and the proxy supplies a valid single `X-Infra-Client-IP`; the proxy must overwrite this header. Unknown accounts use a dummy password hash and generic errors. Database/startup errors have generic responses/diagnostics; no raw exception serialization.

Do not log request bodies, cookies, CSRF values, QR URIs, passwords, OTPs or recovery codes at a reverse proxy. The CLI deliberately displays a newly generated capability once to its operator; run it in a controlled terminal, not a CI job that archives stdout.

## API and frontend

All authentication/application endpoints are under `/infrastructure-api`:

| Method | Path | Authority |
|---|---|---|
| GET | `/auth/csrf` | Creates/resumes only a restricted browser context |
| GET | `/auth/challenge` | Safe current challenge stage, no identity/secret |
| POST | `/auth/bootstrap/redeem` | CSRF + single-use capability |
| POST | `/auth/enrollment/start`, `/auth/enrollment/confirm` | Restricted enrollment/recovery challenge |
| POST | `/auth/login` | CSRF + independent password |
| POST | `/auth/mfa/verify`, `/auth/recovery/verify` | Password-verified MFA challenge |
| GET | `/auth/session` | Full independent session |
| POST | `/auth/activity`, `/auth/logout` | Full session + CSRF |
| POST | `/auth/logout-all` | Full session + CSRF + fresh authentication |
| POST | `/auth/reauthenticate`, `/auth/mfa/replace` | Full session + CSRF + password + fresh OTP |
| GET | `/dashboard` | `infra.dashboard.read` |
| GET | `/servers` | `infra.servers.read`, scoped to account organization |

`/health/live` identifies only the dedicated service. `/health/ready` checks the dedicated database without disclosing connection details. There are no registration, SQL execution, SSH, Docker, terminal, file or production-change endpoints.

The existing frontend owns `/it/infrastructure`, `/login`, `/enroll`, `/verify`, `/session` and `/modules/:module` beneath that prefix. A narrow branch in `src/App.tsx` mounts the independent provider and routes before ordinary providers/overlays. The existing single BrowserRouter moved from AppRouter to App; ordinary routes still use their existing guards/providers. Ordinary auth return-path effects are not mounted for infrastructure routes. Both IT office navigation variants get the entry; office/role rules for ordinary screens are unchanged. Direct URLs work while signed out of ordinary Kodex.

The independent fetch client uses only same-origin cookies and CSRF, serializes mutations across token rotation, and never calls ordinary refresh APIs. Infrastructure pages reuse the current React/Tailwind/Lucide stack and locally rendered `react-qr-code`. The current service worker has no fetch/cache handler, so it does not cache these endpoints. Vite adds only a local `/infrastructure-api` proxy to port 3101. No production Vercel/Caddy configuration was changed.

Dashboard content is authenticated account identity, explicit expiry/MFA status and registered metadata. Agent status is “Not connected / Phase 1.” Database Explorer, SQL Editor, Docker, Applications, Terminal, Logs, File Manager, Backups, Network & Security and Settings display unavailable states. Database/agent TypeScript contracts prepare discovery, metadata, browsing, optimistic edits, bounded queries, cancellation and auditing without registering executable endpoints.

## Local setup and operator procedure

1. Use a disposable auth database separate from existing application data. Apply only migration 0063, wrapped in `BEGIN`/`COMMIT`, with the migration administrator. Create restricted login identities using the reviewed roles example and securely set passwords with interactive `psql` `\password` or a secret manager. Never use the migration administrator for HTTP.
2. Provide the variables below through an untracked local environment file or secret manager. For development use `INFRA_ENABLED=true`, `INFRA_LOCAL_HTTP=true`, listener `127.0.0.1:3101`, and the exact Vite origin (for example `http://127.0.0.1:5173`). Generate distinct random 32-byte keys. Key-ring JSON maps an ID such as `v1` to a base64 key. Do not copy ordinary auth keys, SSH credentials or VITE secrets.
3. Start backend with `npm run dev:infrastructure`, or `npm run build` followed by `npm run start:infrastructure`. Node can load a protected environment file with `node --env-file=/protected/path --import tsx src/infrastructure/server.ts`. Start the existing frontend with `npm run dev` and open `/it/infrastructure/login`.
4. In a separate operator environment, set `INFRA_PROVISION_DATABASE_URL` to the restricted provisioner login and `INFRA_OPERATOR` to the accountable operator identity. Only the explicit organization ID must match the intended local instance. Stage B.1 uses a separate provisioning configuration and never loads the runtime session/MFA keys. Run the commands below. No HTTP registration or ordinary “create user” hook exists.

```sh
npm run infra:accounts -- create operator@example.test 'Local operator' infra.dashboard.read,infra.servers.read
npm run infra:accounts -- register-server 'Local test server' test.invalid
npm run infra:accounts -- permissions operator@example.test infra.dashboard.read
npm run infra:accounts -- revoke operator@example.test
npm run infra:accounts -- disable operator@example.test
npm run infra:accounts -- reset operator@example.test
```

`create` and `reset` print a one-time enrollment capability. Deliver it out of band; redeem it through the UI POST form, never a URL. `reset` intentionally returns the selected account to pending, revokes sessions/challenges/old credentials and requires complete enrollment. Only an authorized custodian should use it after an out-of-band identity check. Other commands print only non-secret results. No password/key/capability is accepted in argv.

## Configuration names (no secret values)

| Variable | Purpose |
|---|---|
| `INFRA_ENABLED` | Explicit opt-in; otherwise startup fails closed |
| `INFRA_DATABASE_URL` | Dedicated non-owner runtime login connection |
| `INFRA_ORIGIN` | One exact trusted frontend HTTPS origin; no wildcard |
| `INFRA_ORGANIZATION_ID` | Explicit owning organization UUID |
| `INFRA_HOST`, `INFRA_PORT` | Independent listener; defaults loopback / 3101 |
| `INFRA_TOKEN_KEY` or `INFRA_TOKEN_KEY_FILE` | Separate 32-byte base64 keyed-digest secret |
| `INFRA_MFA_KEYS` or `INFRA_MFA_KEYS_FILE` | Managed JSON encryption key ring |
| `INFRA_MFA_ACTIVE_KEY` | Key-ring ID for newly encrypted secrets |
| `INFRA_IDLE_SECONDS`, `INFRA_ABSOLUTE_SECONDS`, `INFRA_FRESH_SECONDS` | Configurable session policy |
| `INFRA_TRUSTED_PROXY_IPS` | Optional comma-separated exact socket peers; no implicit forwarding trust |
| `INFRA_LOCAL_HTTP` | Loopback-only development cookie/listener mode |
| `INFRA_PROVISION_DATABASE_URL`, `INFRA_OPERATOR` | Operator CLI only; never inject into HTTP service |
| `INFRA_TEST_ADMIN_URL` | Tests only: local disposable-cluster administrator connection |
| `INFRA_TEST_FRONTEND_DIR`, `INFRA_TEST_CHROME_PATH` | Optional end-to-end test paths |

## Verification

Commands:

```sh
npm run typecheck
npm test
npm run test:infrastructure
# Set INFRA_TEST_ADMIN_URL securely to enable real PostgreSQL tests, then rerun test:infrastructure.
npm ci --prefix tests/infrastructure-browser
npm run test:infrastructure:browser
# In the existing frontend:
npx tsc -b
npm run build
npm run test:session-restore
npm run test:schedule-date
```

Real PostgreSQL and browser tests create random disposable database and login-role names, apply the actual migration, use restricted runtime/provisioner logins, and drop their database/logins afterward. The reusable NOLOGIN privilege groups remain in the local test cluster. Use a cluster dedicated to tests. They never modify the existing application database. The browser harness binds local ports 3101 and 5179; ensure they are free. It blocks external browser traffic and uses a `.test` account and `test.invalid` metadata. Chromium can be supplied with `INFRA_TEST_CHROME_PATH`, or installed with the pinned Playwright package's installer. Browser screenshots contain only disposable dashboard metadata, not QR keys/recovery codes.

Test coverage includes RFC vectors/skew, encryption/account binding/key-ring compatibility, provisioning, mandatory MFA, CSRF/origin checks, disabled/pending accounts, expired/reused bootstrap, concurrent OTP/recovery redemption, restricted recovery, routine replacement, idle/absolute/fresh-auth expiration, cookie flags, revocation, permissions, no operational routes, audit rollback, database outage, lockout expiry and database privilege denials. Existing auth tests include the inverse check that infrastructure cookies/opaque tokens cannot authenticate ordinary `/api/me`. Chromium covers signed-out guards, enrollment/QR/recovery receipt, password+MFA, authorized metadata, unavailable modules, responsive layout, cross-tab logout and navigation back to ordinary login.

Executed local results:

| Check | Result |
|---|---|
| Backend `npm run typecheck` and `npm run build` | Passed |
| Backend `npm test` | 335 tests: 325 passed, 10 existing opt-in tests skipped, zero failures |
| Dedicated infrastructure suite with real PostgreSQL enabled | 17 passed, zero failures/skips |
| Frontend TypeScript project build | Passed |
| Frontend Vite production build | Passed; existing mixed static/dynamic-import warnings remain |
| Existing frontend session restore and schedule date tests | Six passed, zero failures |
| Local Chromium end-to-end flow | Passed, including signed-out route guards, full enrollment/login, metadata, mobile layout, cross-tab logout and ordinary-login navigation |
| Visual inspection | Desktop 1440px and mobile 390px screenshots inspected; no overflow or fabricated telemetry |

Screenshots are local at `/tmp/kodex-infrastructure-verification/desktop.png` and `mobile.png`. The API suite used PostgreSQL from the existing local Docker test infrastructure with newly created disposable databases; browser authentication used the real API and restricted PostgreSQL role, not mocked responses. Frontend commands used the working Node 22.22.2 binary because the alternative local Homebrew Node installation is broken. The browser skill's Node REPL tool was unavailable, so pinned local Playwright/Chromium performed the browser checks. Temporary databases/login roles and test HTTP processes were removed after successful checks.

The exact release scope is listed in `infrastructure-control-center-stage-b-files.txt`. Stage B files remain local for review; no commit, GitHub push, PR or deployment was performed.

## Remaining production prerequisites and limitations

- Approve a same-origin HTTPS proxy path for the existing frontend and independent API. A cross-site Vercel preview cannot use these Strict cookies against an unrelated API domain. The examples are proposals, not installed configuration. Review allowed origin, proxy peers and header overwriting.
- Confirm deployed database role privileges. Existing ordinary superuser credentials can defeat schema isolation. Prefer an isolated auth database/instance or separately approved least-privilege hardening before claiming strong isolation. Never silently alter ordinary grants.
- Assign provisioning/reset and encryption-key custodians, approved owning organization, backup/restore procedures and retention policy. Encrypted DB backups require the key ring to recover MFA secrets. Retain old encryption-key IDs until affected accounts are re-enrolled or a separately reviewed re-encryption job has run. No bulk key-rewrite tool is shipped.
- Replacing the digest key intentionally invalidates outstanding sessions, bootstrap/challenge digests and recovery-code digests. Coordinate fresh recovery-code issuance through re-enrollment/reset; this is not transparent key rotation.
- Runtime audit grants prevent runtime tampering, not database-superuser tampering. External append-only export remains future hardening. Authentication attempts/expired challenges need owner-controlled retention; no runtime audit-delete privilege or automatic production purge is granted. Clear obsolete pending encrypted material during that retention operation.
- The browser shares the ordinary SPA origin. HttpOnly does not prevent same-origin XSS from performing requests. Review existing CSP/third-party scripts before production; a dedicated origin serving the same app bundle would strengthen isolation. No existing production CSP was silently changed.
- PostgreSQL limits replace the architecture's proposed Redis limiter. Availability is fail-closed, but peer-wide throttling and hashing settings need host-specific load/abuse review. Failure to configure a trusted reverse proxy correctly makes the peer limit aggregate at the proxy; it never silently trusts arbitrary forwarding headers.
- `npm audit` reports four existing moderate advisories in the MinIO dependency tree (`minio`, `stream-json`, `query-string`, `decode-uri-component`); none is in the new otplib tree. No unrelated dependency upgrade was applied. Full dependency remediation is a separate review item.
- Operational modules are deliberately unavailable. No agents, Docker sockets, root SSH credentials, arbitrary commands, SQL executor or production mutations are implemented.

Rollback for a future approved deployment is to disable the new service/navigation/proxy mapping while preserving infrastructure authentication and audit data. Do not automatically drop the schema or revoke existing ordinary application grants. Stage B does not authorize a production rollout; review the isolated release diff and development preview first, then follow the established development → PR to main workflow.
