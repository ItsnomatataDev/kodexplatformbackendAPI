# Infrastructure Control Center — Stage B.1 remediation

Review date: 2026-10-11 (Africa/Harare). Local implementation and verification only. No production migration, grants, accounts, deployment, networking, commit, push or PR was performed. Stage C remains unavailable.

## Remediation and boundaries

The HIGH provisioner escalation is removed in the unreleased migration 0063. Provisioners receive schema USAGE and EXECUTE on four fixed administrative functions only: provision_account, manage_account, register_server and record_operator_denial. They receive no table SELECT/INSERT/UPDATE/DELETE grants. They cannot read password/MFA/recovery material, update challenges or modify session tokens, expiration, authentication time or revocation state. The functions are owned by the NOLOGIN infrastructure owner, use a fixed pg_catalog search path and fully qualified relations, revoke PUBLIC EXECUTE and validate arguments. Runtime cannot execute these administrative functions or inherit provisioner authority.

The permitted administrative operations are account creation, exact permission replacement, revoke, disable, enrollment reset and server metadata registration. Revocation only sets revoked_at (preserving existing revocation), increments auth_version and cancels challenges/bootstrap capabilities. It cannot un-revoke or promote authority. Reset clears credentials and returns a new single-use enrollment capability; it still requires password establishment and confirmed MFA before a separate login. **Reset remains powerful recovery authority**: individual operator database identities and out-of-band identity verification are production requirements. It is not an authentication bypass for ordinary IT/admin users.

The CLI uses readProvisioningConfig and needs only its dedicated database URL and organization ID, plus accountable INFRA_OPERATOR attribution. It does not read or return runtime HMAC/MFA keys, even when key-file variables are present. Bootstrap capabilities are 256-bit random values with domain-separated SHA-256 digests; other token purposes retain independent runtime HMAC protection. The operating-system operator environment must not be given runtime key mounts or permission to read them. A configuration unit test and a denied PostgreSQL server-file read prove the implemented boundaries; they do not prove production filesystem ownership.

Successful administrative changes and detailed audit records commit in the same database function/transaction. Permission records contain account ID, organization, supplied operator, database session_user, previous/new/added/removed grants, time, outcome and controlled reason. Server registration records the actual new server UUID and organization. CLI rejections use the fixed record_operator_denial operation after rollback; unavailable audit storage fails the action. Direct SQL callers can roll back their own transactions; infrastructure audit is not tamper-proof against the owner/superuser. Controlled operator access and database/security logging remain required.

## Abuse and audit limits

Before body parsing, Origin/CSRF validation or authentication database queries, each runtime applies a bounded local ingress limiter: 120 requests per trusted peer per fixed minute, 600 total admissions per minute, at most 600 peer entries, and 16 concurrent admitted requests. New windows clear the bounded map. Rejections return 429; only the first rejection per instance/window attempts an ingress-denial database record. Additional suppressed requests are counted in memory and a count-only diagnostic is emitted when a later request starts a new window. Those local counts are not durable across process failure. Critical successful transitions remain individually and atomically audited.

PostgreSQL remains the shared authentication limiter (not Redis): committed, advisory-locked attempt records enforce the original 15-minute account/login/challenge/peer budgets across replicas. The duplicate service-level denial write was removed. HTTP failures invoke a single aggregation function. A validated live session/challenge may establish account identity; arbitrary submitted login names never do. Denials are grouped by database minute, controlled reason, trusted actor and validated account. At most 100 detailed identities plus five reason-specific overflow rows are admitted per database minute across all replicas; further denials increment existing aggregates. Overflow deliberately loses per-source/account detail while preserving reason/count and first/last time/request correlation. No passwords, OTPs, QR URIs, recovery codes, cookie/CSRF values or keys are included.

The local ingress limits multiply with replica count and reset on restart. They are **not a distributed gateway quota**. Production is blocked until an approved common gateway/WAF enforces per-source and aggregate limits across all replicas and the API cannot be reached around that gateway. The nginx example proposes 2 requests/second per peer plus a 10/second aggregate, with bounded bursts; it is a review example, not applied networking or a measured capacity claim. The Caddy routing snippet alone is insufficient.

Owner-only retain_history removes authentication attempts older than one day, denial windows older than 90 days, critical audit events older than 365 days, and challenges expired more than one day ago. Runtime and provisioner cannot invoke it or delete audit history. Schedule daily through the controlled owner channel only after approving encrypted export, incident/legal holds and retention policy. At the database denial-row cap, 90 days can still retain up to 13.608 million aggregate rows; monitor storage and tune approved retention/capacity. Failure to run retention will cause continued growth; this is an explicit operational prerequisite. No retention job was installed in production.

## Health and release acceptance

/health/live checks only the process. /health/ready checks the password service, dedicated database role and schema/audit capabilities. Readiness is rate bounded and returns 503 on dependency/privilege failure. Docker retains liveness health checks to avoid restart loops during database outages. A release must also pass check-readiness.mjs (or the equivalent explicit check in the Compose example) inside the container after startup. Do not expose health endpoints through the public frontend proxy. A healthy Docker container alone does not accept a release.

## Source and release isolation

The exact file inventory is infrastructure-control-center-stage-b-files.txt. Stage B.1 changes migration 0063, the CLI, infrastructure config/pool/crypto/provisioning/service/app, adds auth/ingress.ts, extends unit/PostgreSQL/browser tests and adds the ordinary authentication fixture. Deployment examples add separate provisioning config, rate-limit design, retention and readiness checks. The Stage B document is updated to identify superseded details. The expanded browser test exposed a recovery navigation race: a still-mounted MFA guard redirected to login after the verified stage changed to recovery. InfrastructureRoute.tsx now redirects to the route appropriate for the server-verified session/challenge state; backend authorization is unchanged.

scripts/deploy/build-infrastructure-release.py constructs review patches from the recorded repository HEADs. Dockerfile includes only the infrastructure target; package.json includes only infrastructure commands, unit-test registration and otplib. package-lock.json contains the pinned MFA library and its transitive dependencies. All other included existing-file diffs were inspected: authentication.test.ts adds inverse trust rejection; App.tsx adds independent route scope; AppRouter.tsx moves BrowserRouter to App; Sidebar adds the IT entry; vite.config.ts adds the local proxy. Unrelated media worker/test additions and media, tickets, attendance, password and ObligationBanner files are excluded. Working-tree content is preserved, and the original indexes are never staged.

The generated /tmp/kodex-infrastructure-stage-b1-release directory contains both patches, a README and manifest.json with exact base commits, file hashes and hunk ranges. Re-run the generator after any source/report edits. Apply checks and clean-copy verification are recorded below; do not apply these patches on top of the already modified working trees.

## Production prerequisites (not implemented by changing production)

- Confirm same-origin HTTPS delivery and proxy precedence before the SPA fallback. Strict host-only cookies require the reviewed routing arrangement; Vercel's existing SPA rewrite is insufficient. Keep the dedicated API process and restricted network binding.
- Inspect actual PostgreSQL grants, memberships, PUBLIC access and ordinary application's effective role. An ordinary application using a shared-cluster superuser can bypass schema isolation. Approve restricted ordinary credentials or a separate infrastructure authentication database instance before claiming strong isolation. Disposable tests do not attest live roles.
- Provision individual restricted operator identities, approve organization and custodians, enforce out-of-band reset verification, and keep provisioning and runtime environments separate.
- Store independent runtime secrets in a secret manager or protected read-only files accessible only to the intended service. Do not use SSH/root secrets or VITE variables. Prove encrypted backup restoration together with key recovery. Rotating the HMAC key invalidates sessions/challenges/recovery digests; coordinate re-enrollment/recovery generation. Retain old MFA key IDs until re-enrollment or a separately reviewed re-encryption operation has completed.
- Review existing shared-origin XSS exposure and CSP unsafe-inline/unsafe-eval. HttpOnly does not prevent same-origin malicious scripts from invoking the API. B.1 does not silently change shared CSP or claim separate browser-origin isolation.
- Approve the common gateway limiter, exact trusted socket IPs and header overwrite. For multiple gateways, shared enforcement is required; independent nginx zones do not coordinate across hosts. Test that direct API ingress is inaccessible.
- Approve retention/export and incident response, schedule maintenance, monitor database/limiter availability, and require readiness plus authenticated smoke checks before release acceptance. Audit is insert-only for the runtime, not tamper-proof against a database superuser.
- Reconcile the production migration ledger explicitly. Migration 0063 was only used in disposable local tests and is edited as an unreleased migration. If any external environment already applied an earlier 0063, stop and prepare a separately reviewed forward migration; do not overwrite its history or run all pending local migrations.

Database and agent files remain contracts only. No SQL executor, arbitrary query endpoint, Docker socket/control, SSH terminal, filesystem management or privileged agent was introduced. Reserved operational permissions remain ungrantable until separately authorized Stage C work.

## References used during remediation

[PostgreSQL 17 SECURITY DEFINER documentation](https://www.postgresql.org/docs/17/sql-createfunction.html) informed fixed search paths, owner boundaries and restricted EXECUTE. [nginx request limiting documentation](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) supports the proposed shared-zone gateway example. Neither reference verifies the live deployment.

## Verification and verdict

**Verdict: CONDITIONAL PASS for Stage B + B.1 code review. Production release remains blocked by the prerequisites above.** No unresolved Critical/High implementation finding from the Stage B review remains in the tested scope. This is not a fresh production security audit or permission to deploy.

| Original severity / finding | Remediation evidence |
|---|---|
| High — provisioner session/MFA escalation | migration 0063 lines 78–180; fixed operations in auth/provisioning.ts; separate readProvisioningConfig; actual restricted-role and CLI tests |
| Medium — unlimited/duplicate denial rows | auth/ingress.ts; app.ts ingress middleware and sole error handler; service.ts single denial writer; migration record_denial and retain_history |
| Medium — incomplete administrative audit | migration manage_account/register_server, including immutable database session_user and permission differences; validated-context denial attribution |
| Low — liveness mistaken for readiness | app.ts /health/ready plus check-readiness.mjs and explicit Compose release acceptance |
| Additional functional issue — recovery redirect race | frontend InfrastructureRoute.tsx follows verified state; expanded real-browser recovery succeeds |
| Additional availability issue — dummy-hash startup concurrency | service.ts shares one handled dummy-hash initialization per process; readiness fails closed if unavailable |

Verification completed locally with Node 22.22.2, disposable PostgreSQL databases and headless Chrome. The two repository builds used installed lockfile dependencies; clean copies reused those dependency directories, rather than claiming a fresh offline installation.

| Check | Result |
|---|---|
| Working backend typecheck + build | PASS |
| Complete working backend suite | 337 tests: 327 passed, 10 existing opt-in skips, 0 failures |
| Isolated release backend typecheck + build | PASS |
| Isolated release backend suite | 268 tests: 258 passed, 10 existing opt-in skips, 0 failures; unrelated media tests correctly excluded |
| Infrastructure unit + real PostgreSQL suite | 25 passed, 0 skipped, 0 failures |
| Working and isolated frontend typecheck/build | PASS; existing dynamic-import bundling warnings remain |
| Frontend session-restore + schedule-date regressions | 2 + 4 passed |
| Real browser against isolated release copies | PASS: enrollment/QR, recovery-code receipt, password/MFA, recovery and re-enrollment, idle expiry, operator revocation, mobile shell, unavailable modules, cross-tab logout, ordinary login navigation, captured browser-log secret exclusion |
| Exact-base patch apply checks | PASS for 39 backend and 16 frontend files |

The initial clean-backend full run exposed a pre-existing deployment-test fixture omission: HEAD's Compose requires MEDIA_ORIGIN_ACCESS_KEY, MEDIA_ORIGIN_SECRET_KEY and MEDIA_PLAYBACK_SIGNING_SECRET, while HEAD's test supplies none. The successful clean run supplied **synthetic test-only values** for those three variables. No media source/test/config changes were included. Do not describe that initial unconfigured run as passing.

PostgreSQL negative tests assert SQLSTATE 42501 for 14 provisioner statements: session insertion; token replacement; expiry extension; authentication timestamp changes; clearing revocation; challenge promotion; reading encrypted MFA, pending challenge secrets, password hashes or recovery hashes; reading a runtime key file with pg_read_file; granting runtime membership; SET ROLE owner; and invoking retention. Runtime administrative execution and audit mutation are denied too. The actual CLI is run in child processes through create → permissions → revoke → disable → reset with deliberately unreadable runtime key-file variables; every command succeeds without accessing them, and five attributable database audit events are checked.

Authentication tests verify concurrent use of one OTP across different valid challenges permits exactly one session, logout-all invalidates independently issued sessions, CSRF proof from one session cannot authorize another, and valid ordinary IT/admin JWTs work on ordinary /api/me but fail on infrastructure. Ordinary logout leaves infrastructure access intact; infrastructure logout leaves ordinary access intact. Invalid MFA failures are attributed to the validated account exactly once (10 attempts produce 10 aggregated occurrences), and shared throttles reject a second service instance. Database/audit outages fail closed. Liveness remains 200 while unavailable readiness returns 503.

Observed abuse simulation: **850 invalid requests produced 3 denial aggregate rows in one database minute**, with **250 rejected by ingress**. This includes 400 invalid-Origin requests split across two runtime instances, then 150 real expired-session requests, 150 missing-session requests and 150 invalid-CSRF requests. Rotating spoofed forwarding headers did not change the untrusted socket identity. Another 200 unique actors exercised the overflow cap; no database minute exceeded 105 rows. Retention removed old fixtures, and both restricted identities were denied retention execution. These are functional bounds, not production throughput benchmarks. Suppressed local counts, overflow identity loss and gateway requirements are described above.

Audit examples below normalize disposable identifiers and omit secrets:

```json
{
  "action": "account.permissions",
  "actor": "operator:test",
  "database_actor": "infra_test_<random>_provision",
  "account_id": "<disposable-account-uuid>",
  "organization_id": "<disposable-organization-uuid>",
  "previous_permissions": ["infra.dashboard.read", "infra.servers.read"],
  "new_permissions": ["infra.dashboard.read"],
  "added_permissions": [],
  "removed_permissions": ["infra.servers.read"],
  "successful": true,
  "reason": "operator_requested",
  "created_at": "<database-event-time>"
}
```

Server registration similarly records action `server.registered`, actual registered `object_id`, organization, operator, database identity, timestamp and successful outcome. Authentication denial aggregates record controlled reason, validated account when available, actor, first/last request/time and occurrence count. Nested arbitrary request metadata is never serialized.

Exact B.1 edited/added paths (the combined release inventory also includes the earlier Stage B files):

- `migrations/0063_infrastructure_authentication.sql`
- `src/cli/infrastructure-accounts.ts`
- `src/infrastructure/app.ts`, `config.ts`, `db/pool.ts`, `crypto/secrets.ts`
- `src/infrastructure/auth/provisioning.ts`, `service.ts`, `ingress.ts`
- `tests/infrastructure.test.ts`, `infrastructure-postgres.test.ts`, `infrastructure-ordinary-fixture.ts`, `infrastructure-browser/run.mjs`
- `deploy/infrastructure/.gitignore`, `Caddyfile.example`, `compose.example.yml`, `infrastructure.env.example`, `provisioning.env.example`, `nginx-rate-limit.example.conf`, `retention.example.sql`, `check-readiness.mjs`
- `scripts/deploy/build-infrastructure-release.py`
- `docs/architecture/infrastructure-control-center-stage-b.md`, `infrastructure-control-center-stage-b-files.txt`, `infrastructure-control-center-stage-b1.md`
- Frontend: `src/features/infrastructure/auth/InfrastructureRoute.tsx`

Release bases: backend `c290692718af1074a23488402fda84b749b5d36e`; frontend `40a860a55de47a328bc0ebba04918953b221099e`. The generated manifest records every file SHA-256 and exact hunk headers. No required infrastructure source/deployment/test file is missing from the combined manifest. Stage A's earlier architecture proposal is not part of this implementation patch. No media, ticket, attendance, password or ObligationBanner changes were staged or included.

Evidence logs are `/tmp/kodex-b1-final-backend.log`, `/tmp/kodex-b1-final-clean-backend.log`, `/tmp/kodex-b1-postgres.log`, `/tmp/kodex-b1-final-frontend.log`, `/tmp/kodex-b1-final-clean-frontend.log` and `/tmp/kodex-b1-final-browser.log`. Screenshots in `/tmp/kodex-infrastructure-verification/` contain disposable dashboard metadata only. Production proxy/CSP, filesystem key permissions, existing database grants, gateway capacity, restore drills and live readiness still need separately authorized deployment validation.
