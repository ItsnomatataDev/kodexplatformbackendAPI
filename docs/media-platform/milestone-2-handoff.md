# Milestone 2 — Production-safe media backend

Latest readiness evidence: [Milestone 3](milestone-3-handoff.md). This document records the Milestone 2 implementation baseline.

Date: 2026-10-08. Branch: `fix/private-media-cdn-readiness`.

The migration collision, worker publication race and missing tenant control plane have local implementations and regression coverage. No frontend, VPS, production data or deployed services were changed. Existing Content Studio routes, legacy worker command and v1 playback remain supported. **Frontend readiness is not declared**; remaining operational/browser/revocation gates are listed below.

## Migration history reconciliation

`0058_media_platform.sql` and `0059_media_job_leases.sql` remain unchanged. The time-entry SQL is byte-for-byte unchanged, moved from `0058_time_entry_auto_stop.sql` to `0060_time_entry_auto_stop.sql`. `0061_media_publication_fencing.sql` adds the fencing sequence/tokens, published HLS/MP4 generation pointers and variant generations.

The planner identifies historical migrations using both version and description. It never edits/deletes historical ledger rows or their timestamps:

| Existing ledger | Interpretation and pending work |
| --- | --- |
| `0058 / media_platform`, `0059 / media_job_leases` | Media history already applied; run time-entry 0060 and fencing 0061 |
| `0058 / time_entry_auto_stop` | Time-entry 0060 is already applied under its historical identity; run media 0058, leases 0059, fencing 0061 |
| Fresh ledger | Apply the unique consecutive source sequence 0001–0061 |
| Unknown version/description | Fail closed; require operator reconciliation |

New ledger entries use the complete filename in the existing VARCHAR `version` column, e.g. `0061_media_publication_fencing.sql`. Existing numeric entries remain intact. This allows a missing media 0058 to be recorded alongside a pre-existing numeric 0058 time-entry row without overwriting it. The new runner must accompany the migration files; an older version-only runner is incompatible with this reconciled ledger. Do not mix partial deployment manifests or leave the obsolete duplicate file in the root migrations directory of a release checkout.

A session advisory lock serializes cooperating migration runners. The runner strips the two imported outer BEGIN/COMMIT wrappers so each migration's SQL and ledger insert share one transaction. The content of historical SQL files was not edited. This preserves execution atomicity instead of allowing an embedded COMMIT to precede ledger registration.

Tests cover both legacy histories, unknown history, repeat planning and source-version uniqueness. The disposable PostgreSQL harness also exercises real SQL application, concurrent runners, repeat execution, and exact preservation of old ledger versions/descriptions/timestamps. These are controlled replicas, **not a claim about the uninspected VPS ledger**. Manually applied SQL without a matching ledger row still requires an operator audit; never guess or backfill history automatically.

## Publication fencing

Every successful claim obtains a globally increasing bigint from `media_platform.fencing_tokens`. Job and asset store that token. Claims lock the asset and job with `SKIP LOCKED`, so two jobs for one asset cannot process concurrently; different assets remain parallelizable.

The worker captures its token once. Heartbeat, failure and publication require matching job ID, worker identity, fencing token, processing status and an unexpired lease. Reusing a worker name cannot resurrect a previous claim. PostgreSQL uses `clock_timestamp()` for expiry checks, including the final publication write, rather than transaction-start time.

Processors write only under:

```text
.media/v2/{assetUuid}/{fencingToken}/hls/...
.media/v2/{assetUuid}/{fencingToken}/playback/playback.mp4
```

Variant changes are attempt-local drafts, not shared database writes. All uploads, including the HLS master, finish before publication. A transaction locks the asset, verifies the live claim, inserts ready variants, updates the appropriate published-generation pointer and completes the job. It checks expiry again after variant writes; lease expiry during publication rolls back all variants/pointers/completion together.

A stale upload can finish in its obsolete private prefix, but cannot overwrite the published generation's keys. New playback grants sign the published generation as well as asset ID and expiry. Tampering with the generation invalidates the HMAC; rejected/unpublished generations cannot be selected by manipulating a valid grant. No client supplies a generation to the control-plane API.

Failure/recovery updates are fenced too. A failed replacement preserves the last successful publication. An exhausted initial job marks an unpublished asset failed. Processing retries obtain fresh tokens/prefixes. Recovery also handles legacy processing jobs with NULL lease expiry so they cannot block an asset indefinitely. Old publications and aborted attempts are retained; garbage collection must later distinguish published generations, outstanding grants and orphan attempts. No destructive cleanup was introduced.

This is fencing for trusted worker code against crashes, lease expiry and concurrency, not per-process MinIO IAM isolation against a malicious worker with stolen credentials. Never reset the fencing sequence or restore a database snapshot while workers continue writing; recovery procedures must quiesce workers and preserve sequence uniqueness.

## Control plane and delivery

New routes use existing Kode Bearer/session middleware, current organization context and Content Studio permissions. Asset registration checks tenant source ownership before origin access and atomically creates the initial job. Status/variants/grants enforce tenant scope; DTOs omit bucket names, private keys, ownership tokens and internal errors. Concurrent registration and processing requests are idempotent where active work already exists.

See [frontend API contract](frontend-api.md) for exact endpoints, request/response shapes and errors. New URLs use `/media/v2/{expiry}/{signature}/{assetUuid}/{generation}/hls/master.m3u8`. The edge and signer also retain v1 support for existing production delivery. Existing v1 rows are not silently adopted as v2 publications; only a successfully fenced job creates a v2-ready generation.

Revoked sessions/permissions prevent API access and new grants immediately. Previously issued v2 bearer grants expire after five minutes; there is no per-segment session revocation lookup. Accept this explicitly or add a separately designed revocation mechanism before release if immediate revocation is required. CORS/player renewal/browser behavior remains unverified.

The conservative 30-second edge TTL remains in place for both legacy and v2 media. V2 generations now permit longer immutable caching, but no long-cache policy change was mixed into this correctness milestone. Cached access still requires a valid grant.

## Worker deployment separation

`media-worker` remains the legacy Content Studio worker. A separate `media-platform-worker` Docker target and `media-processing` Compose profile run the fenced worker. It has a read-only root filesystem, a UID-10001 writable disk scratch volume, 1.5 CPU, 1536 MiB memory and 128 PIDs. This removes the new worker's dependency on the legacy 4-GiB tmpfs. Disk quota, scratch cleanup after hard crashes and capacity alerts must be configured before production use; the volume alone is not a hard storage bound.

Use new-worker-specific `MEDIA_WORKER_ACCESS_KEY`/`MEDIA_WORKER_SECRET_KEY`, injected only into that service's MinIO variables. They must read authorized source objects and write derivative `.media/v2/*` prefixes; no administrative/public-bucket grants. Empty credentials fail startup through existing environment validation. Generic API/MinIO credentials and settings were not changed. Media-auth's read-only policy must include both `.media/v1/*` and `.media/v2/*`. Host networking and the existing broad `.env.vps` file are retained for the new worker's current PostgreSQL/storage topology; stronger service-specific secret/network isolation remains an operational follow-up.

## Files changed for this milestone

- Migration rename, new 0061, `src/db/migration-plan.ts`, migration runner and related deployment-manifest/document reference.
- Media types/store/jobs, processor drafts, worker orchestration and HLS/MP4 generation object paths.
- Playback token/URL/edge verifier/origin signer, auth forwarding and Nginx v2 namespace.
- `src/routes/media-platform.ts` and `src/app.ts` route mounting/dependency injection.
- Separate worker Docker target/Compose service and scratch volume.
- Migration, control-plane and generation unit tests; expanded private-origin/PostgreSQL integration fixtures; default test script includes the new cases.

Milestone-1 working-tree edits were preserved. Unrelated routes/frontends were not changed.

## Validation and limits

Commands:

```sh
npm run typecheck
npm run build
npm test
npm run test:media:integration
```

The full suite reported **320 passed, 10 skipped, zero failures** (330 tests). This includes cross-tenant control-plane denial, revoked permissions/sessions, read-only permissions, source ownership before origin access, DTO redaction, unready playback, both legacy migration plans and generation signature tampering. TypeScript checks and build passed.

Local private MinIO/Nginx/auth/FFmpeg integration reported **89 checks passed**, retaining v1 delivery and exercising v2 HLS master/renditions/init/segments, correct bytes/MIME/relative links, Range/HEAD, cache authorization and expiry, private-bucket access and error caching. Auth outage with a warm cache fails closed. PostgreSQL integration exercises concurrent source registration, cross-tenant SQL, serialization of duplicate jobs, stale-owner/token rejection, same-worker-name reclaim, retry exhaustion, failed-job state and preservation of a prior publication. A late obsolete-generation upload is tested against real MinIO and does not change the currently published bytes delivered through the edge.

The final integration passed actual migration replay for both histories and rollback when a lease expires *during* variant insertion. A PostgreSQL sequence probe confirms insertion began before expiry, so this is a mid-transaction rollback test rather than only preflight rejection. Legacy processing jobs without lease expiry were also recovered successfully in the final run. The test command exited successfully and removed its isolated containers/volumes. Tests use unique disposable local Compose resources and dummy credentials only. They do not access production or prove production health.

Not covered: a full OS-kill/restart test of the long-running worker process, complete historical application-schema replay from 0001, production-like load/eviction, orphan/scratch garbage collection, disk quotas, browser Safari/MSE/audio/portrait/renewal/CORS matrix, live credential rotation or an actual VPS ledger audit. The previous dependency audit's moderate MinIO/transitive findings and digest pinning remain release-review items.

## Approved rollout sequence to prepare (not executed)

1. On a separately approved operational change, capture immutable API/auth/edge/new-worker image references and restricted config snapshots; back up the database. Obtain a read-only ledger report including both `version` and `description`. Match it to the planner's known histories; stop for any unknown/manual history.
2. Prepare a complete release checkout with exactly one file per numeric migration. Preserve the old release for rollback; do not overlay new files onto a directory that retains the obsolete 0058 time-entry file. Do not edit existing database ledger rows. Use the new migration runner with the new source set, never the old version-only runner.
3. Quiesce any old **media-platform processing** workers before schema/worker transition. Do not replace or stop the unrelated legacy Content Studio worker as part of this change. Existing v1 delivery can continue. Production actions require separate approval; none is implied by this document.
4. Provision service-specific worker credentials and expand only the read-only media-auth prefix policy to v2. Configure the API's matching signing secret and HTTPS public base origin. Never print expanded Compose configuration, env files or signed paths.
5. Rehearse migration on a restored isolated copy, then run the approved migration procedure. 0061 is additive; no objects or existing variant rows are deleted. Verify the published-generation columns and sequence before enabling the new worker/API routes. New routes depend on this schema and must not be enabled against an unmigrated database.
6. Build/validate reviewed images and syntax. After separate approval, deploy v2-capable auth/edge before issuing v2 grants, then the API and separately profiled new worker. API deployment is necessary to expose the new endpoints but **has not been authorized or performed in this session**. A proposed worker-only command after prerequisites is:

```sh
docker compose --env-file .env.vps -f docker-compose.vps.yml --profile media-processing up -d --no-deps media-platform-worker
```

Use a reviewed prebuilt image/override and confirm database/storage availability; `--no-deps` deliberately does not recreate shared infrastructure. Do not run the command merely because it is documented.

7. Validate a controlled tenant fixture through registration, processing, variants, grant issuance and private-edge byte delivery. Verify cross-tenant/revoked access denial and existing Content playback regressions. Keep capability values in the test client's memory and out of logs. Do not point the disposable integration runner at production: it intentionally creates/deletes test data.
8. Public Caddy routing remains a separate approved change after browser/CORS tests. The earlier unapplied example remains a proposal, not an active route.

## Rollback

Stop the new fenced worker before rollback; let uncompleted leases expire/recover under the correct version later. Roll back API/edge/auth images as a coordinated approved change, retaining v2 edge support for outstanding five-minute grants where possible. Existing Content routes/v1 delivery remain available independently. Leave additive schema, generation objects, scratch/cache volumes and all ledger rows intact; no destructive down migration or prune is needed.

Do **not** run the old migration runner against a ledger containing filename identities. Retain the reconciled runner for future migrations even if application images are rolled back. Never restart the old unfenced media-platform worker as a rollback strategy against active v2 jobs. Do not reset the sequence, delete generation objects or change generic MinIO policy to recover service. If database restore becomes necessary, stop writers first and use a reviewed restore/namespace plan.

## Frontend-readiness gates

- [x] Tenant/session/permission-checked control-plane routes implemented and unit-tested.
- [x] Immutable attempt prefixes and generation-bound playback grants.
- [x] Lease owner plus fencing-token checks for heartbeat/failure/publication.
- [x] Atomic ready-variant, asset-pointer and job-completion publication.
- [x] Local stale-publication, concurrent-job and failed-job tests against real services.
- [x] Known 0058 histories supported without rewriting legacy ledger rows.
- [ ] Actual production ledger and source inventory audited by an authorized operator.
- [ ] Grant revocation delay accepted, or immediate revocation implemented if required.
- [ ] Long-running worker crash/restart and scratch/orphan retention controls rehearsed.
- [ ] Browser/CORS/renewal compatibility and operational capacity/security review complete.
- [ ] Approved deployment/rollback and actual production private delivery verified.

Until these remaining gates pass, the correct status is **backend correctness changes implemented and locally validated; frontend/production readiness pending**.
