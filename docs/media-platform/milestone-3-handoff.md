# Milestone 3 — Production readiness verification

Date: 2026-10-08. Branch: `fix/private-media-cdn-readiness`.

**Assessment: GO for continued local backend verification; NO-GO for production rollout or declaring frontend readiness.** The local correctness/delivery gates below pass. Production ledger, configuration, revocation acceptance, capacity/retention operations and broader browser qualification remain open. No VPS connection, production migration, deployment, service restart or frontend application modification was performed. Milestone 2 working-tree changes and legacy Content Studio playback were preserved.

## Gate evidence

| Gate | Result | Evidence and boundary |
| --- | --- | --- |
| Both migration histories | Local PASS; production OPEN | Disposable PostgreSQL replays media-0058 and time-entry-0058 histories, concurrent runners, idempotent repeats and unchanged historical ledger timestamps. Operator read-only inspection SQL and offline checker run against both fixtures. Actual VPS history/source checksums have not been inspected. |
| Crash/restart | PASS locally | Actual compiled worker SIGKILL during held source download, fixture lease expiry, new process recovery, higher fencing token, second attempt and successful publication. |
| Paused/expired worker | PASS locally | Actual worker SIGSTOP during source download, lease expiry, replacement process publication, SIGCONT and late obsolete upload. Captured fixed lease-loss event proves rejected stale finalization; published pointer/job token stay current. Earlier tests also reject stale heartbeat/failure, reused worker names and expiry during a publication transaction. |
| Generation retention | PASS under tested retain-all policy; operations OPEN | Worker IAM explicitly denies DeleteObject/DeleteObjectVersion. Attempts to delete current, previous and orphan generations fail with AccessDenied; objects remain and prior master ETag is unchanged. Tests use the exact checked-in policy example. There is no GC or bucket lifecycle expiry in this fixture. This does not constrain root/admin credentials or an independently configured lifecycle policy. |
| Browser HLS | PASS for local Chrome/hls.js; matrix OPEN | Chrome 154.0.8037.98 with hls.js 1.6.15 decodes actual FFmpeg output, advances playback and requests signed master/rendition/init/segments through real private MinIO/auth/Nginx. No mocked origin or bypass of browser security. |
| Browser CORS and expiry | PASS locally; production config OPEN | Separate loopback page/edge origins; expired master/rendition/init/segment requests return readable 403; renewed grant works. Approved Range/If-Range preflight succeeds, unapproved headers/origin fail. Default shipped allowlist is empty; production HTTPS origins must be reviewed. |
| Edge authorization/cache | PASS locally | 89 existing private-origin HTTP/FFmpeg checks: byte identity, relative HLS links, v1 compatibility, Range/HEAD, expiry/wrong signature on warm cache, public-origin denial and uncached errors. Auth outage with warm cache fails closed. Sanitized edge logs checked for capability/signature leakage. |
| Tenant control plane | PASS locally | Default unit suite covers organization/session/permission denials, source ownership before origin access, response redaction, failure states and generation signing. Real PostgreSQL fixtures cover scoped reads/enqueues, duplicate/concurrent work and prior publication preservation. |
| TypeScript/build/regressions | PASS with explicit skips | `npm run typecheck`, `npm run build`, `npm test`: 320 passed, 10 skipped, zero failures. Media integration suite passes separately against disposable services. |
| Playback revocation | OPEN product/security acceptance | Existing grants remain usable for up to 300 seconds after API permission/session revocation; new grants/renewals are denied. No per-grant immediate revocation exists. |
| Production operations | OPEN | No actual ledger/config/TLS/backup/restore/rollout/rollback verification, production load test or deployment was performed. |

The lifecycle harness uses SQL to move **only disposable fixture leases** past expiry, keeping production's 90-second lease and 30-second heartbeat unchanged. It tests actual process loss/resumption, not a 90-second wall-clock wait, network partition endurance or an OOM soak. The held download makes timing deterministic; FFmpeg, worker orchestration, storage writes and publication are real. A stricter intermediate run exposed formatted-log parsing in the harness; it was corrected to retain only the fixed lease-loss event and the final rerun passed. No raw worker logs or bearer URLs are retained by the browser harness.

## Reproduce locally

Prerequisites: local Unix-socket Docker context, Node/npm, installed Google Chrome and free loopback ports 43181/43182. The browser dependencies are isolated from the application package:

```sh
npm ci --prefix tests/media-cdn/browser --ignore-scripts
npm run typecheck
npm run build
npm test
npm run test:media:integration
```

The integration runner uses dummy fixture credentials, a unique Compose project and disposable PostgreSQL/MinIO volumes. It exposes only the media edge on an ephemeral **127.0.0.1** port, serves two local test pages, and removes containers/volumes at exit. It rejects remote Docker contexts/DOCKER_HOST. Do not point this destructive fixture runner at shared or production services. Browser failures fail the command; they are never counted as skips or passes. Browser harness code is outside the application frontend and emits only aggregate results/version.

Ten default-suite tests were skipped because their application PostgreSQL/schema fixtures were unavailable: statement timeout, idle transaction timeout, social post bounds, leave request bounds, schedule playback PostgreSQL/Hono scenario, security detection, security event reads, security tenant lifecycle, integration credentials and integration ingest. They are **not marked passed**. Dedicated media PostgreSQL tests did run. Full historical application-schema replay from 0001 was not performed.

Not run: native Safari/iOS, Firefox, audio/portrait media, seamless in-player token renewal and seek across expiry, production HTTPS/Caddy routing, realistic long-video/resource/load/cache-eviction tests, live rotation, full database restore or any production-origin test. Browser verification proves local Chrome delivery, not the entire future frontend player lifecycle.

Production dependency audit: `npm audit --omit=dev` reports four moderate findings (MinIO and transitive decode-uri-component/query-string/stream-json), no high/critical findings. The isolated browser dependency audit reports zero findings. Dependency remediation and immutable image/digest review remain release gates; no broad dependency upgrades were made here.

## Migration inspection

Follow [the read-only procedure](migration-ledger-inspection.md). It provides a reviewed SQL capture plus an offline planner check. Unknown or manually applied history, schema/ledger disagreement or unexpected early pending migrations is a STOP condition. Never repair/backfill the production ledger as part of inspection. Both known histories passing locally cannot substitute for an authorized operator's production metadata review and isolated restore rehearsal.

## Retention and storage permissions

Adopt the reviewed [worker policy example](../../deploy/media-edge/worker-policy.example.json) for a dedicated new-worker identity, separate from media-auth's GetObject-only identity. This example is exercised by real MinIO integration tests. Provision/review policies only in a separately authorized operational change. The new worker must never use MinIO root credentials. Confirm no independent lifecycle expiry or cleanup job targets `.media/v2/` before rollout.

Current policy is **retain all generations**, including failed attempts and superseded publications. This avoids deleting generations still referenced by issued grants or in-flight playback; it does not bound storage usage. SIGKILL can also leave scratch files. Establish storage/scratch capacity, alerts, budget and a safe operational cleanup procedure before enabling sustained production processing. Do not add a blind age-based prefix deletion or `rm -rf` on shared active scratch storage. Future GC needs publication/job ownership checks, protection for all grant lifetimes (legacy helpers can issue longer grants), a recovery/in-flight safety window and concurrency tests before it is enabled. Worker fencing protects cooperating worker publication, not a compromised writer with broad PutObject privileges or an administrator deleting objects.

## Grant policy and browser contract

Recommend keeping the explicit control-plane TTL at **300 seconds**, with renewal approximately 60 seconds before expiry and fail-closed handling of renewal denial. Require documented acceptance of the five-minute revocation delay. Downloaded/buffered data cannot be revoked; a response authorized before expiry may finish afterward. Shorter 60–120 second grants can reduce the window for high-sensitivity use but require renewal/latency validation. Immediate revocation requires stateful edge checks or a revocation/version mechanism; TTL alone cannot provide it. The edge currently validates the signed capability, not current tenant membership on every segment. See the updated [frontend API contract](frontend-api.md).

`deploy/media-edge/media-cors.conf` is an exact-origin allowlist and defaults to no cross-origin access. The production Compose mount and image include it. Review HTTPS page origins before deployment; never deploy the loopback fixture allowlist. OPTIONS discloses only preflight metadata; every GET/HEAD, including cache hits, still executes auth_request. Allowed origins receive CORS headers on errors as well as success. CORS is a browser access rule, not an authorization boundary for a stolen bearer URL. Browser media requests should omit cookies. Reference behavior: [Nginx response-header inheritance](https://nginx.org/en/docs/http/ngx_http_headers_module.html), [Playwright Chrome channels](https://playwright.dev/docs/browsers), [hls.js player API](https://github.com/video-dev/hls.js/blob/master/docs/API.md).

## Explicit deployment gates and rollback

Before any rollout, obtain separate authorization and close these gates:

1. Authorized read-only VPS ledger/source/schema audit and successful rehearsal on an isolated restored database; reviewed backup/restore evidence and full candidate release inventory with no obsolete duplicate migration file.
2. Security/product acceptance of grant revocation delay, or implementation and tests of immediate revocation if required. Resolve/review dependency findings and pin release image identities.
3. Dedicated reader/writer identities and reviewed no-delete policy; no lifecycle expiry of active/granted generations. Capacity/scratch limits, monitoring, cleanup ownership and operational resource tests agreed.
4. Correct exact HTTPS CORS origins, media host/TLS/Caddy configuration, strong matching API/auth signing secret supplied through existing secret management, and browser/player renewal/seeking compatibility for supported clients. Never paste secrets or expanded Compose config into review evidence.
5. Approved coordinated release, controlled tenant private-origin smoke test, legacy Content Studio regression and rollback rehearsal. No assertion of production delivery until tested against the actual working private origin.

Keep the [Milestone 2 rollout/rollback ordering](milestone-2-handoff.md): quiesce old unfenced media-platform workers, use the reconciled migration runner with a complete source set, verify additive fencing schema, then deploy v2-capable auth/edge and API/new worker under separate approval. The unrelated Content Studio worker stays on its existing implementation. Default-deny CORS must be configured before enabling cross-origin playback.

Rollback stops the new worker first, reverts reviewed application/config images as a coordinated change and preserves schema, ledger rows, sequence and generation objects. Maintain v2 delivery for outstanding grants where possible. Do not reset fences, prune media, run destructive down migrations, restart an old unfenced worker against active v2 jobs or use the old numeric-only migration runner against the reconciled ledger.

## Files changed in Milestone 3

- `scripts/media-platform/inspect-ledger.sql`, `check-ledger.mjs`; new migration inspection procedure.
- `tests/media-cdn/worker-lifecycle.mjs`, `jobs.mjs`, `migrations.mjs`, `run.mjs`, `run.sh`, `compose.yml`, `cors.conf`; real process lifecycle and retention tests, read-only inspection/checker coverage and browser orchestration.
- `tests/media-cdn/browser/{verify.mjs,package.json,package-lock.json}`; isolated real-browser HLS/CORS tests.
- `deploy/media-edge/{nginx.conf,Dockerfile,media-cors.conf,worker-policy.example.json}` and `docker-compose.vps.yml`; default-deny CORS configuration and tested worker policy example.
- This handoff, Milestone 2's link to current evidence and the frontend API contract. Existing Milestone 1/2 changes remain present; this list distinguishes current work from the larger uncommitted branch diff.
