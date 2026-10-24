# KODEX Infrastructure Control Center — Stage A

Inspection date: 2026-10-10. Status: architecture proposal for review; Stage B not started.

Only this report was created for this task. No source, permissions, production data, environment, networking, or containers were changed. Existing unrelated working-tree changes were left intact. The report describes local source plus previously supplied deployment evidence, not a fresh production security audit.

## 1. Actual architecture

The existing product spans two established repositories. Integration must use both; no new repository or frontend application is needed.

| Area | Observed implementation |
|---|---|
| Backend | `/Users/thando/Desktop/devprojects/kode-platform`; TypeScript ES modules, Hono, Node HTTP adapter. `src/server.ts` starts HTTP, WebSockets, Redis chat and attendance scheduler; `src/app.ts` assembles route factories and dependencies. |
| Frontend | `/Users/thando/Desktop/devprojects/ITsNomatataWorkSpace`; React 19, TypeScript, Vite 8, React Router 7, Tailwind 4, Lucide icons. `src/main.tsx` → `src/App.tsx` → `src/app/router/AppRouter.tsx`. |
| Frontend organization | Existing `src/features/it-workspace/`, auth pages, reusable common components, global providers and sidebar. Kode adapters coexist with legacy Supabase paths. Files with names ending in ` 2.ts` also exist; change only the modules actually imported. |
| Ordinary client | `src/lib/api/client.ts` attaches Kodex bearer tokens, includes cookies, silently refreshes sessions and retries requests. `src/lib/kode/auth.ts` adapts `/me` into existing frontend profile shapes. |
| Storage | PostgreSQL `pg` pools, Redis, MinIO; domain stores use interfaces and parameterized SQL, with memory implementations for many tests. |
| Deployment | Existing `/opt/kode-platform/docker-compose.vps.yml` on VPS; API and media processes, PostgreSQL 17, Redis, MinIO, reverse proxy. Frontend uses GitHub: development first, then reviewed PR to main. GitHub deployment settings/domains were not independently verified. |

The existing `src/features/security-center/` is a security monitoring product, not independent infrastructure authentication. Its `/it/security` route redirects to `/admin/security`. Do not reuse that redirect or place the new feature under general Admin.

## 2. Existing authentication and authorization

Backend references: `src/auth/routes.ts`, `defaults.ts`, `login.ts`, `sessions.ts`, `cookies.ts`, `passwords.ts`, `access-token.ts`, `middleware.ts`, `resolve-context.ts`; `src/authorization/authorize.ts`, `permissions.ts`, `types.ts`.

- Ordinary credentials/sessions live in `identity.password_credentials`, `identity.sessions`, and `identity.refresh_tokens` (migration 0005), tied to `identity.users` and `identity.user_profiles`.
- Ordinary HTTP `/api` authentication uses an HS256 access JWT in `Authorization`, verifies its session, resolves current organization membership, then checks account state. Refresh tokens are opaque, hashed, rotated, and revocable.
- Cookies are `kode_refresh` (HttpOnly, `/auth`) and `kode_csrf` (JavaScript-readable, `/`). Secure ordinary cookies currently use SameSite=None, accommodating separate frontend/API origins.
- Ordinary passwords use Argon2id, but the shared password validator currently permits four characters. Infrastructure must have its own stronger policy; do not silently change ordinary users' policy in this project.
- Organizations use `organizations.organizations`, `roles`, `memberships`, and `offices`. Membership carries organization, role ID/key, office, and status; a unique partial index permits one active organization per ordinary user. Permissions are JSON; the general authorization helper grants admin-role bypass.
- `src/routes/it.ts` uses ordinary roles and office checks. `src/security/permissions.ts` explicitly permits broad security-staff access. Neither gate is appropriate for infrastructure.
- No implemented TOTP/WebAuthn infrastructure authentication was found in the inspected backend source/dependencies.

**Conclusion:** reuse low-level patterns, not the ordinary trust relationship. Ordinary IT/admin roles, JWTs, refresh cookies, password-reset endpoints and admin bypasses must confer no infrastructure authority.

## 3. Exact navigation and frontend integration

Observed integration points:

- `src/app/router/AppRouter.tsx`: IT route block starts around line 1326. Existing IT screens use `ProtectedRoute` and `RoleRoute`.
- `src/components/dashboard/components/Sidebar.tsx`: `getRoleNav()` around line 315; `case "it"` around line 509. Other-office IT returns only Service Desk; master-office IT gets broader Control Centre navigation. Subsequent feature/office filters start around line 1008.
- `src/lib/auth/itOfficeAccess.ts`: current office and path restrictions.
- `src/App.tsx`: ordinary authentication, notification and branding providers plus global overlays.
- `src/app/router/AuthReturnPathListener.tsx`, `AppDocumentTitle.tsx`, and `src/app/providers/AuthProvider.tsx`: global route effects to review for independent login compatibility.

Proposed routes in the existing router:

| Path | Gate |
|---|---|
| `/it/infrastructure/login` | No ordinary login required; independent primary authentication |
| `/it/infrastructure/enroll` | Restricted, authenticated bootstrap challenge only |
| `/it/infrastructure/verify` | Pending password-verified MFA challenge only |
| `/it/infrastructure` | Full infrastructure session plus `infra.dashboard.read` |
| `/it/infrastructure/session` | Full session; self-session controls |

Use a new `InfrastructureRoute` and route-local provider, not ordinary `ProtectedRoute`/`RoleRoute`. A valid infrastructure session must work when ordinary Kodex is signed out, and an ordinary session must never satisfy the infrastructure guard.

Add “Infrastructure Control Center” under IT. The entry may lead ordinary IT users to the separate login page; seeing this link grants nothing. Protected module navigation appears only after infrastructure authentication/permission validation. Approved infrastructure administrators can use the direct URL regardless of their ordinary role or office. Do not widen `canITOpenPath` for unrelated IT screens or grant infrastructure authority based on the `itGodmother` flag.

Reuse Tailwind colors, typography, spacing, icons and presentational components. The existing full Sidebar/security layout depends on ordinary `useAuth`, so use a module-specific layout rather than mounting those dependencies unchanged. Suppress unrelated global notification/AI/install overlays on infrastructure routes through a narrow path branch where needed; do not refactor ordinary providers broadly. Do not cache auth/MFA API responses in the existing service-worker path.

## 4. Backend conventions and recommended runtime boundary

`src/app.ts` installs security headers, CORS, request IDs/logging, trusted-proxy client IP, body limits and CSRF globally. Ordinary `/auth` is separate from the bearer-protected `/api` subapp. Domain routes are Hono factories with injectable stores. Errors use `src/http/errors.ts` and centralized serialization. `src/types/hono.ts` carries typed request context.

The global CSRF implementation imports `kode_csrf` and conditionally checks its presence. Infrastructure requires its own strict validation, including login/enrollment, and must not depend on that ordinary cookie being present. Likewise the ordinary client must not be used for infrastructure HTTP requests.

**Recommended:** a dedicated infrastructure Hono runtime/entrypoint inside this same backend repository and build system. It exposes only `/infrastructure-api/*`, uses its own restricted PostgreSQL pool, Redis namespace, encryption keys, auth middleware and allowlisted frontend origins. It must not import the ordinary `createApp`, start work schedulers, or load ordinary database/root/SSH secrets. Pure middleware factories can be reused after dependency review; several existing helpers import global ordinary `env`/`db` and are not safe to reuse unchanged.

This remains one product and one frontend. A separate backend process provides meaningful separation from compromise of the ordinary API process. A same-process subapp would provide logical session separation but expose both pools and secrets to the same runtime; it is the weaker alternative and is not the recommendation.

Development can use an additive Vite proxy. Production requires an explicitly reviewed additive service and reverse-proxy mapping; prepare configuration examples only in Stage B until deployment approval. Do not modify existing networking or restart production as part of implementation.

## 5. PostgreSQL, migrations and privilege boundaries

Observed: `src/db/pool.ts`, `pool-config.ts`, `transaction.ts`; parameterized SQL; pool max 10, connection timeout 5 seconds, statement timeout 30 seconds, idle-in-transaction timeout 60 seconds. Migration files are numbered SQL under `migrations/`, recorded in `platform.schema_migrations` and applied transactionally by `src/db/migrate.ts`.

The local migration planner supports the historical 0058 collision and full-filename ledger identities. The VPS was updated explicitly with 0060 and 0062 during this conversation; 0061 has not been confirmed applied. **Do not run all local pending migrations blindly.** Reserve the next available number after reviewing the branch/ledger; 0063 is currently a candidate, not a guaranteed allocation. Never rewrite historical ledger rows or insert no-op placeholders for missing history.

Proposed dedicated `infrastructure` schema:

| Entity | Purpose and essential controls |
|---|---|
| `accounts` | Independent UUID, normalized unique login, Argon2id hash, display name, owning-organization identifier, pending/active/disabled state, auth version, timestamps. No ordinary-user credential association or auto-import. |
| `account_permissions` | Explicit permission enum/catalog and grants; issuer/change audit. No wildcard or IT/admin inheritance. |
| `bootstrap_tokens` | Hashed single-use, short-lived provisioning capability, account binding, expiry/consumption timestamp. |
| `mfa_credentials` | Extensible credential type; encrypted TOTP secret, nonce/tag/key version, account-bound associated data, confirmed time, last accepted TOTP counter. Future WebAuthn credentials have separate type-specific fields. |
| `recovery_codes` | Individual high-entropy code hashes, generation ID, used/revoked time. Never plaintext persistence. |
| `auth_challenges` | Hashed challenge ID, stage/purpose, account binding, CSRF binding, expiry, attempt count and consumption time; never grants protected access. |
| `sessions` | Hashed random token, account, creation/last activity, idle and absolute expiry, authentication/MFA times, revocation and auth version. |
| `authentication_attempts` | Bounded failure/success metadata for abuse investigation; no submitted password, OTP or raw session values. |
| `audit_events` | Actor, action, outcome, object, request ID, trusted source IP, timestamp and allowlisted metadata. Support unknown actor for failed login. |
| `servers` | Registered server ID, owning organization, display address/label and future agent reference. Metadata only in Phase 1; no root password/private key. |

Use a separate infrastructure migration owner and non-owner runtime role, and a distinct controlled provisioning role. Runtime receives only necessary rights to new schema objects; audit table is insert-only for runtime, not update/delete. Grant schema usage and object privileges explicitly, remove PUBLIC privileges on new objects/functions, pin search paths and qualify SQL. Do not revoke privileges globally or alter existing roles. Provisioner has narrowly scoped account/grant/revocation authority; it is not a database superuser used by HTTP requests.

Existing Compose initializes PostgreSQL via POSTGRES_USER; source alone cannot prove the deployed application's effective role privileges. Inspect them during a later approved deployment. A schema does not protect data from an existing superuser: if ordinary application credentials are superuser-level, hardening or an isolated auth database instance must be approved before claiming a strong database isolation boundary. Do not silently change production grants to solve this.

Rollback: disable the new service/routes and preserve auth/audit data. Destructive down-migration is only for empty disposable environments, never automatic production teardown. Encrypted backups and encryption-key recovery are required before enabling real accounts.

## 6. Independent authentication and provisioning

No registration endpoint and no ordinary “create user” hook. Provisioning uses a local operator CLI in this repository with explicit owning organization, login and exact infrastructure permissions. First-account bootstrap uses that same controlled channel; a shell/operator identity is recorded, never invented as a Kodex user ID. The CLI must not accept secrets as command-line arguments or log them.

Recommended flow:

1. Authorized operator creates a pending infrastructure account and a short-lived single-use bootstrap capability, delivers it out of band, and records issuance.
2. User enters the capability through a POST-based enrollment flow; do not put it in a URL/query/history/referrer. The server creates only a restricted bootstrap challenge.
3. User chooses a distinct infrastructure password (proposed 15–128 characters, allow paste/password managers, no trimming or forced composition). Hash using Argon2id with benchmarked parameters; never use or request the VPS SSH password.
4. Server generates TOTP secret, encrypts it immediately, and returns an enrollment QR payload only to the authenticated bootstrap challenge, over TLS with no-store. Existing `react-qr-code` can render it locally; no external QR service.
5. Successful first TOTP confirmation atomically activates MFA/account, consumes bootstrap challenge, records the accepted counter and issues recovery codes once. User saves them; require a fresh full password+MFA login afterward rather than promoting bootstrap into a dashboard session.
6. Normal login verifies password and returns a short-lived MFA challenge, never a full session. Successful TOTP or a recovery code completes authentication, rotates challenge/session identifiers and issues a new infrastructure session.

Proposed initial controls: 30-second TOTP step, six digits, at most ±1 step drift; five-minute challenges; transactionally advance the accepted counter so simultaneous/repeated OTP acceptance cannot succeed. Use a maintained TOTP implementation selected and pinned during Stage B, with RFC vectors and concurrency tests, rather than a new handwritten OTP algorithm. Encrypt TOTP with authenticated encryption and key IDs using a separate managed secret, never AUTH_TOKEN_SECRET or a VITE variable.

Recovery codes are one-use and atomically consumed. Password is still required. Recovery-code login yields a restricted recovery session to re-enroll MFA, not ordinary operational access. Require existing password plus fresh MFA for routine MFA replacement; revoke other sessions, old secrets and recovery generations on replacement. Loss of both factors requires an audited out-of-band operator reset; no support bypass through ordinary Kodex login.

Per-account and trusted-IP throttles apply independently to password, bootstrap, MFA and recovery attempts, with bounded temporary lockout/backoff, generic errors and a dummy password hash for unknown accounts. Shared Redis limiting must fail closed on outage; PostgreSQL challenge counters/replay controls remain authoritative. Hash normalized login keys in limiter metadata to avoid unnecessary identifier exposure. Suggested thresholds require load/abuse testing; do not advertise them as measured production settings.

## 7. Sessions, CSRF and endpoint contract

Proposed session policy: 256-bit opaque random tokens; only their keyed hashes stored; distinct key from ordinary auth and MFA encryption. Secure HttpOnly host-only cookie `__Host-kodex_infra_session`, Path=/, no Domain. Separate short-lived bootstrap/challenge cookie, also Secure/HttpOnly. No JWT reuse, bearer fallback or localStorage session storage.

Prefer SameSite=Strict with same-origin or same-site API routing. The current frontend/API origins must be confirmed: a cross-site Vercel preview cannot simply use Strict cookies against a different site. Use a reviewed same-origin proxy arrangement; never weaken to SameSite=None without a specific reviewed requirement. Preview origins must be explicitly authorized, not wildcard trusted. Same-site and same-origin are different constraints.

Dedicated server-bound CSRF token returned by a no-store endpoint and held in memory, attached as `X-CSRF-Token` for every mutation. Require exact Origin and reject absent/wrong token even if the ordinary cookie is missing. Cover login CSRF and challenge/enrollment as well as full sessions. Ordinary `kode_csrf` must neither satisfy nor break infrastructure CSRF. Session/challenge cookies are purpose-bound and rotated on transitions.

Proposed endpoints, all on the independent runtime:

- `GET /infrastructure-api/auth/csrf`: pre-auth session-bound CSRF challenge.
- `POST /auth/login`, `/auth/mfa/verify`, `/auth/recovery/verify` under that prefix: bounded staged authentication.
- `POST /auth/bootstrap/redeem`, `/auth/enrollment/start`, `/auth/enrollment/confirm`: restricted bootstrap state machine.
- `GET /auth/session`: identity, effective infrastructure permissions, MFA state and remaining session lifetimes; never secrets.
- `POST /auth/logout`, `/auth/logout-all`, `/auth/reauthenticate`: session revocation and fresh password+MFA proof.
- `GET /dashboard`, `/servers`: full infrastructure session plus `infra.dashboard.read` / `infra.servers.read`; only registered metadata.

Initial proposed idle timeout 15 minutes, absolute lifetime 8 hours, fresh-auth window 5 minutes for sensitive changes; review these values before implementation. Enforce them server-side, including concurrent requests. Background status polling must not perpetually extend idle lifetime. Revocation/disable/permission changes take effect on subsequent requests; no stale JWT permission cache. Logout invalidates the database session and clears cookies even across tabs. Ordinary logout does not revoke infrastructure sessions and vice versa.

Phase 1 HTTP permissions are `infra.dashboard.read`, `infra.servers.read`, and self-session management. Provision/manage/revoke account authority belongs to the controlled administrative channel. Reserve future `infra.database.read` and `infra.database.write` separately, but do not grant or implement operational permissions now.

## 8. Audit and security risks

Existing facilities: Pino with configured redaction; `src/auth/events.ts` emits lifecycle events; `src/security/recorder.ts` persists security events; `security.audit_log` and `it.audit_logs` also exist. They are organization/ordinary-user oriented. The security metadata scrubber does not recursively scrub arrays; generic metadata key matching is not sufficient protection for OTP/QR/recovery payloads.

Use a dedicated infrastructure audit writer with an explicit metadata allowlist. Successful security transitions and their audit event commit atomically. If required audit persistence fails, do not issue credentials/sessions or change MFA. Log attempts, denials, bootstrap, enrollment, verification, recovery, provisioning, revocation, lockout and fresh-auth outcomes. Redact secret material before logging; never serialize request bodies/errors containing credentials. Administrative retention/export is a separate privileged operation. Insert-only DB grants are not tamper-proof against a database superuser; an external append-only audit sink is later hardening.

| Risk | Required mitigation |
|---|---|
| Ordinary IT/admin privilege leaks | Separate accounts, pool, runtime, guards and explicit permissions; cross-session negative tests. |
| Browser/XSS shares the ordinary SPA origin | HttpOnly helps against token theft but does not prevent same-origin scripted requests. Isolate module state, minimize global integrations, avoid HTML injection, audit CSP/third-party scripts. Existing vercel.json permits unsafe-inline/unsafe-eval; stronger dedicated-origin delivery of the same app bundle is a future hardening option, not something this design can claim already solved. |
| Cross-site login/cookie misconfiguration | Reviewed origin/proxy topology, strict CSRF on all auth transitions, exact CORS. |
| Bootstrap takeover/recovery bypass | One-use expiring capabilities, password establishment plus verified TOTP, restricted recovery, no ordinary-admin bypass. |
| MFA replay/concurrent redemption | Transactional compare/update on TOTP counters, recovery codes and consumed challenges. |
| Database/key compromise | Distinct service credentials, least privilege, encryption key outside DB, key-version rotation, protected backups. Shared PostgreSQL superuser risk remains explicit. |
| Endpoint abuse/DoS | Body caps, IP/account limits before expensive hashing, bounded concurrency and lockouts, fail closed. |
| Fake operational readiness | Metadata-only server identity; “Not implemented in Phase 1” modules, no fabricated telemetry. |
| Release drift | Isolated commits, tested migration plan and exact file manifest; no incidental media/other pending changes deployed. |

## 9. Proposed modules and exact modification scope

Backend new modules under `src/infrastructure/`:

- `server.ts`, `app.ts`, `config.ts`, `context.ts`: dedicated runtime, optional validated configuration and typed principal.
- `auth/{routes,service,passwords,provisioning,challenges,mfa,recovery,sessions,cookies,csrf,rate-limits}.ts`.
- `authorization/{permissions,middleware}.ts`.
- `db/{pool,store,postgres-store,memory-store}.ts`.
- `crypto/{secret-box,tokens}.ts`, `audit/{events,writer}.ts`.
- `routes/{dashboard,servers}.ts`, `servers/store.ts`.
- `database/contracts.ts` and `agent/contracts.ts`: types/design boundaries only; no execution implementation.
- `src/cli/infrastructure-accounts.ts`: controlled provisioning, disable, revoke/reset workflows.
- New numbered additive SQL migration, `tests/infrastructure-*.test.ts`, opt-in real-PostgreSQL tests, deployment/runbook documentation.

Backend existing files expected to change: `package.json`/lockfile (commands and reviewed MFA dependency), `Dockerfile` (additive non-root infrastructure target), `.env.*.example` (new optional, separate variables only), test command registration as needed. Shared middleware/config changes only if narrowly necessary to accept injected settings; no changes to ordinary auth behavior. `src/app.ts`/`src/server.ts` do not need to mount or start this dedicated runtime. Add a separate Compose example/overlay and proxy example, not a live networking edit. New runtime uses its own request type instead of overwriting ordinary Hono `auth` context.

Frontend new `src/features/infrastructure/`:

- `pages/{InfrastructureLoginPage,InfrastructureEnrollmentPage,InfrastructureMfaPage,InfrastructureDashboardPage}.tsx`.
- `components/{InfrastructureLayout,InfrastructureSidebar,SessionStatus,ModuleUnavailable}.tsx`.
- `auth/{InfrastructureProvider,InfrastructureRoute}.tsx`.
- `services/infrastructureClient.ts`, `types.ts`, tests.

Frontend existing changes: `src/app/router/AppRouter.tsx`, `src/components/dashboard/components/Sidebar.tsx`, `src/app/router/AppDocumentTitle.tsx`, narrow integration in `src/App.tsx`, and `vite.config.ts` for local proxy if needed. Review auth return-path handling and service worker exclusions; change only if tests demonstrate coupling. Reuse `react-qr-code`; no new design framework. Production `vercel.json`/proxy changes are proposed configuration subject to topology review, not approved live edits.

Infrastructure-specific configuration examples: enable flag, listener address, allowed origins, dedicated DB role/connection settings, Redis namespace/identity, owning organization ID, encryption key-ring reference, token-hash key, session policy. Do not enable by default or make ordinary API startup depend on infrastructure secrets. No SSH/root credentials in this configuration.

## 10. Dashboard and future operational boundaries

Dashboard shows independently authenticated administrator identity, explicit session expiry/MFA indicators, logout, registered server label and configured SSH-style display address. Label agent status “Not connected / Phase 1” unless a real agent integration exists. A registration can display the known VPS address, but never treat `root@...` as the application's execution identity. Server registration is an explicit controlled action, not a production migration seed.

Navigation placeholders: Server Overview, Database Explorer, SQL Editor, Docker Management, Application Management, Web Terminal, Server Logs, File Manager, Backups, Network & Security, Infrastructure Settings. No action endpoints for these placeholders.

Future database contract: server/connection IDs resolved by backend registry, no caller-supplied database hosts/passwords. Separate discovery/read and approved-write identities, schema/table/column discovery, relationships, bounded cursor pagination, allowlisted identifier/column/filter AST, parameterized values, optimistic concurrency for visual edits, explicit write permissions, transaction limits, cancellation, row/byte/time ceilings, redacted query history and auditable results. Read-only credentials and transaction mode enforce read isolation; a SQL keyword filter cannot safely authorize arbitrary SQL. Do not register SQL/query endpoints in Phase 1.

Future agent contract: versioned authenticated requests, explicit action enum and resource scopes, nonce/replay protection, timeouts/output caps, audit correlation, preferably private transport/mTLS. Dedicated non-root service identity; narrow privileged helper only if later reviewed. No arbitrary command strings, host filesystem mounts, SSH private keys, sudo blanket grants or Docker socket exposure. Contracts are preparation, not permission to install/run an agent now.

## 11. Tests and implementation order

Existing backend uses Node's test runner with tsx, dependency-injected route tests and memory stores. `npm run typecheck` and `npm test` are established; database tests explicitly opt in with environment flags. Frontend uses TypeScript/Vite builds and several Node test scripts; a comprehensive browser test suite is not established by the inspected scripts. Plan targeted browser integration tests for new auth screens and session transitions.

Implementation order after review:

1. Confirm runtime/origin topology, designated organization, provisioning custodians and session policy. Freeze API/state-machine contracts and permission enum.
2. Add schema/migration and dedicated DB identities in disposable development PostgreSQL; prove least-privilege grants with negative SQL tests.
3. Implement provisioning, password hashing and encrypted MFA bootstrap; prove failure/rollback behavior before UI work.
4. Implement atomic TOTP/recovery/challenge validation, abuse controls and audit persistence.
5. Implement full sessions, expiry, logout/revocation, fresh-auth and strict CSRF; verify independence from Kodex.
6. Integrate frontend routes/client and IT entry, enrollment QR, MFA UI and protected metadata-only shell.
7. Run regression/build, real PostgreSQL and browser checks; prepare a preview and exact release manifest. No production account/grant/config changes as part of coding.
8. Review preview/security tests before a PR to main, consistent with the user's development-first workflow. Production deployment remains a separate explicitly approved operation.

Required tests include: unknown/disabled/unprovisioned login; ordinary IT/admin JWTs/cookies rejected; valid infrastructure session with ordinary session absent; partial challenges denied dashboard access; QR accessible only to bootstrap; TOTP RFC vectors/clock skew/replay/concurrent redemption; recovery one-use and restricted scope; expired/consumed bootstrap; fixation rotation; CSRF absent/wrong token and origin; idle/absolute/fresh-auth expiry; permission and account revocation; cross-tab logout; independent logout in both systems; Redis/DB/audit outage fails closed; hash/key rotation; secret-free logs including nested arrays; database privilege denial; server registration permissions; no operational/SQL/terminal endpoints; existing ticket/attendance/auth route regression; responsive shell and no fabricated metrics.

## 12. Review decisions before Stage B

Recommended for acceptance: same frontend and repositories; dedicated infrastructure backend runtime; separate accounts and least-privileged DB identity; mandatory password plus TOTP; CLI-only account bootstrap; host-only cookie sessions; metadata-only shell under IT.

Still to resolve before deployment: actual frontend/preview/API origins and proxy path, current DB role privileges, who controls provisioning/reset and encryption-key custody, owning-organization ID, session timeout policy. Stage B can develop against local approved defaults, but must not infer production credentials, grants or network changes.

Stage A is complete. Stage B requires review of this proposal as requested in the brief.

## Primary security references

- [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html): enrollment, factor replacement and recovery are security-sensitive authentication flows.
- [RFC 6238](https://www.rfc-editor.org/rfc/inline-errata/rfc6238.html): TOTP time steps, validation window and rejection of a previously accepted OTP.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): server-side expiration, session rotation and invalidation.
- [PostgreSQL privileges](https://www.postgresql.org/docs/16/ddl-priv.html): schema/object grants and default PUBLIC function privileges; verify against deployed PostgreSQL 17 during implementation.
