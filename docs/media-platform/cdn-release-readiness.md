# Private CDN release review — 9 October 2026

Decision: **NO-GO for production activation** pending the gates below. This is a local review, not production verification. No production access, deployment, ledger edits, staging, commit or push was performed. Deadline requested: 08:00 Africa/Harare on 9 October; this report does not assert the deadline was met.

## Changes made in this review

- `src/media-platform/processing/adaptive-hls.ts`: expose pure scaling helpers for regression coverage and document existing tier semantics. Both selection and sizing already use `Math.max(width, height)`. Scale stays capped at one; dimensions round to nearest integer then reduce odd values to even.
- `tests/media-hls-scaling.test.ts`: landscape, portrait, small source, exact rounding, boundary selection, even sizes, aspect ratio tolerance and no-upscale coverage.
- `package.json`: append scaling coverage to `test:media`; retain all previous tests.
- This report and `cdn-release-files.txt`: release boundaries and operator runbook.

The unchanged 1080p/720p/480p tiers cap the **long edge** at 1080/720/480. For 1920×1080, outputs are 1080×608, 720×404, 480×270; portrait transposes them. 320×240 gets one 480p-tier variant at 320×240. These are not conventional vertical-resolution labels. Show actual manifest RESOLUTION to clients; a future separately approved ladder can use 1920/1280/854 long-edge targets or rename tiers. Do not change bitrate, object-key or variant names in this release. Even rounding introduces small aspect-ratio error; this is not mathematically exact aspect preservation.

## Release boundary

`cdn-release-files.txt` lists exact candidate changed/new CDN runtime, test and documentation paths relative to the repository root. Existing unchanged dependencies (including source staging, storage, 0058 media and 0059 leases) remain part of the base release. Review diffs against the actual production revision, not just local HEAD. Do not build or publish the dirty workspace wholesale.

**Exclude** attendance/HR/scheduling edits, `docs/api/attendance-time-auto-stop.md`, `scripts/deploy/end-of-day-files.txt`, `scripts/migration/password/password.html`, deletion of `migrations/0058_time_entry_auto_stop.sql`, and addition of `migrations/0060_time_entry_auto_stop.sql`. Do not stage broad directories or use `git add .`.

**Hold outside the minimal deployable artifact:** `src/db/migrate.ts`, `src/db/migration-plan.ts`, `tests/media-migrations.test.ts`, `scripts/media-platform/check-ledger.mjs`, `scripts/media-platform/reconcile-restored-ledger.sql`. These are migration validation/reconciliation work, not approval to run them. The new planner requires consecutive filenames and knows about the attendance rename. Shipping it without that rename produces an invalid general migration set; shipping the whole set makes 0060 pending. Do not run the general migrator. The restore reconciliation SQL explicitly prohibits production use.

The current integration fixture exercises these held migration changes. After extracting a clean release candidate, repeat build/media/integration/deployment and legacy regressions there; current results alone do not certify that extracted artifact. Freeze a reviewed migration strategy before tagging any release.

## Audit and activation gates

- **Schema/ledger:** physical 0058/0059 objects do not prove ledger reconciliation. Obtain fresh read-only production metadata, compare full column types/defaults, indexes and constraints with original SQL and restored rehearsal, and approve a specific reconciliation transaction. Rehearse a CDN-only 0061 transaction with an atomic ledger insert, advisory lock and bounded lock timeout; exclude 0060. Do not reset the fencing sequence. No production migration write command is authorized or supplied until actual ledger evidence establishes the right transaction.
- **Credentials/env:** host-network worker inherits `.env.vps`, staging env guards and DB configuration. `MEDIA_WORKER_ACCESS_KEY`/`MEDIA_WORKER_SECRET_KEY` override generic MinIO credentials only for the new worker. Verify nonempty values, `MINIO_ENDPOINT` host-loopback routing, DB connectivity and required shared environment validation. Reader uses separate read-only `MEDIA_ORIGIN_*`; API/auth must share a >=32-character playback secret, API requires an HTTPS `MEDIA_PLAYBACK_PUBLIC_BASE_URL`. Never print resolved compose config or env values.
- **Origin isolation:** worker policy permits source reads and v2 derivative writes, explicitly denies derivative deletion. Reader must only read derivative prefixes; anonymous source/derivative requests must fail. Verify effective policies and bucket privacy, not merely example files.
- **Resources:** FFmpeg/ffprobe installed in worker image; runs UID/GID 10001. New named scratch volume initialized from owned `/scratch`, but existing volume ownership must be tested. Worker limit 1.5 CPU/1536 MiB/128 PIDs, one job at a time; legacy worker has its own identical CPU/memory allocation. Edge 0.5 CPU/256 MiB, auth 0.25 CPU/128 MiB. Source cap 2 GiB does not bound derivative scratch usage. Scratch is disk-backed and unbounded; SIGKILL can leave orphan directories. Verify disk quota/headroom, inode capacity, monitoring and stopped-worker cleanup procedures, plus peak concurrent legacy workloads. No mass scratch deletion while jobs run.
- **Edge:** loopback 3100 only; private auth network, edge shares MinIO default network. Authorization runs on every cache hit; generation in signed path/cache identity; ranges bypass cache; only 200 responses cache for 30 seconds; browser responses are private/no-store. Retain old generations for unexpired grants. Nginx suppresses error logs to prevent bearer/signature leaks; sanitized access logs remain.
- **CORS/TLS:** checked-in allowlist denies all origins. Operator must add exact approved HTTPS frontend origins and validate TLS proxy routing before activation. CORS is browser policy, not authorization. Do not change live DNS as part of this work.
- **Health/observability:** API has a liveness check. New worker/auth disable inherited healthcheck; production edge has `/health` but no Docker healthcheck. Running containers and edge `/health` do not establish origin/auth/DB readiness. Require external end-to-end probes, job age/lease/failure alerts and restart/OOM/disk monitoring before GO.
- **Recovery:** leases 90s, heartbeats/recovery 30s, job timeout 30min, 45s graceful stop, retries capped by job attempts. PostgreSQL atomically publishes variants and generation under asset/job fencing with a final deadline check. Old publication survives replacement failure. Uploads can outlive a lease but generation separation prevents overwriting current bytes; orphan object retention needs capacity policy.
- **Compatibility:** new `/media-platform` routes enforce tenant permissions and source ownership before storage access. Existing legacy Content Studio worker command remains `dist/content/playback-worker.js`. Do not recreate it or change schedule/approval paths. Five-minute HLS grants require client renewal for longer playback; confirm intended client integration before directing users to new delivery.

## Human preflight (approval required before production execution)

Use an existing approved operator session and protected credential mechanism, never connection strings on command lines. From the reviewed candidate directory:

```sh
umask 077
psql -X -qAt --set=ON_ERROR_STOP=1 --file=scripts/media-platform/inspect-ledger.sql > /restricted/ledger.json
# Offline, in validation checkout with its compiled planner:
node scripts/media-platform/check-ledger.mjs /restricted/ledger.json
```

A successful checker is not schema equivalence. Capture backup/restore evidence, current image IDs, compose files, protected env/CORS config, deployed revision, migration checksums and effective MinIO policies. Establish immutable previous/candidate image tags in reviewed compose overrides before proceeding.

```sh
# On approved host only; config -q avoids dumping interpolated secrets.
docker compose --env-file .env.vps -f docker-compose.vps.yml config -q
docker compose --env-file .env.vps -f docker-compose.vps.yml ps
docker stats --no-stream
df -h
df -i
# Build only selected services from the clean candidate, after review:
docker compose --env-file .env.vps -f docker-compose.vps.yml build api media-auth media-edge media-platform-worker
# Does NOT start the processing loop or dependencies:
docker compose --env-file .env.vps -f docker-compose.vps.yml run --rm --no-deps --entrypoint sh media-platform-worker -eu -c 'id; test -w /scratch; p=$(mktemp /scratch/preflight.XXXXXX); rm "$p"; ffmpeg -version | head -n 1; ffprobe -version | head -n 1'
```

Verify credential presence without logging values, then perform a reviewed disposable-object read/write/denied-delete test using worker credentials and reader denied-write test. Inspect existing job backlog before enabling a worker: it will claim all eligible jobs, not just a chosen canary. A dedicated canary queue/database or an explicitly approved backlog is required.

## Deployment order after gates and separate human approval

1. Retain previous immutable images and protected configs; verify backup restore and legacy schedule/approval/client playback baseline. Freeze general migrations.
2. Execute only the separately reviewed/rehearsed reconciliation and CDN 0061 transaction. Confirm ledger and schema; no 0060, no full migrate command.
3. Install reviewed CORS/TLS config, then start auth and edge explicitly. Do not use broad `--profile media up`, which can touch the legacy worker.
4. Deploy API with scoped command and immediately smoke legacy endpoints. Rolling/restart impact must fit the approved window.
5. After credentials, capacity, backlog and rollback signoff, enable exactly one new worker. Watch one complete publication before expanding traffic.

```sh
# APPROVAL-ONLY; use reviewed image-pinning override as applicable.
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --no-deps media-auth media-edge
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --no-deps api
# LAST: explicit worker activation approval only
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --no-deps --scale media-platform-worker=1 media-platform-worker
```

## Post-deployment smoke tests

Check API live/readiness and edge `/health`; verify an authorized canary registers and publishes, unauthorized/cross-tenant requests fail, actual HLS master/rendition/init/segments decode, portrait/landscape geometry is correct, MP4 and Range/HEAD work, allowed browser CORS succeeds and denied origin fails. Expired/tampered grants must fail on warmed cache, renewed grants work, anonymous MinIO fails. Check edge logs do not expose tokens/signatures. Check worker lease renewal, queue latency, failures, memory/CPU/disk and legacy worker progress. Play an existing scheduled item, inspect next scheduled transition, exercise a designated approval/client-delivery test item without modifying real schedules. Do not simulate crashes/outages in production; use isolated rehearsal evidence.

## Rollback

Stop the new worker first; preserve schema, fencing sequence, objects and ledger. Revert only candidate API/auth/edge/config using immutable previous images. Do not run compose down, volume removal, database restore over live data, or schema drops. A stopped job can recover on later reactivation after lease expiry. If edge/auth had no predecessor, stop only those new services after disabling new client traffic; keep legacy delivery running.

```sh
docker compose --env-file .env.vps -f docker-compose.vps.yml stop -t 45 media-platform-worker
# rollback-images.yml must have been reviewed and populated with retained prior image IDs.
docker compose --env-file .env.vps -f docker-compose.vps.yml -f /restricted/rollback-images.yml up -d --no-deps --no-build api media-auth media-edge
# Only if auth/edge were entirely new and no older grants depend on them:
# docker compose --env-file .env.vps -f docker-compose.vps.yml stop media-auth media-edge
```

Repeat legacy schedules, approval and client-delivery checks. Missing rollback image/config evidence is a NO-GO gate, not a reason to invent image tags during an incident.

## Exact local verification results

- `npm run build`: exit 0.
- `npm run test:media`: exit 0; 66 passed, 0 failed, 0 skipped (six new scaling tests).
- `node --test tests/vps-deployment.test.mjs`: exit 0; 4 passed, 0 failed, 0 skipped.
- `npm run test:media:integration`: first run exit 1 on obsolete `1080p resolution` assertion (expected 1920×1080). Updated to the documented long-edge dimensions and added actual FFprobe dimension checks for all three renditions. Rerun exit 0: 94 private-origin HTTP/FFmpeg checks, both migration-history fixtures, PostgreSQL fencing/tenant/concurrency/failure recovery, real worker SIGKILL and SIGSTOP recovery, browser Chrome HLS decode/CORS/expiry/renewal, and warm-cache auth outage all passed. This script uses assertions rather than a TAP test count.
- Additional regression command: `node --import tsx --test tests/media-control-plane.test.ts tests/media-migrations.test.ts tests/content-media-auth.test.ts tests/media-storage-stream.test.ts tests/content-studio-reliability.test.ts tests/content-review-feedback.test.ts tests/schedule-playback.test.ts` with development fixture environment and `PLAYBACK_TEST_DATABASE_URL` pointing exclusively at a disposable local PostgreSQL 17 container: exit 0; 51 passed, 0 failed, 0 skipped. Initial run without that fixture had 50 passed/1 skipped; the rerun closes that gap.
- `git diff --check`: exit 0. Local integration containers/volumes cleaned by runner trap; separate schedule fixture removed.

These tests do not verify production capacity, restored-production schema equivalence, real credentials or the final extracted release artifact.

## Reasons for inherited candidate changes

The exact paths are in the adjacent manifest; changes below were already present when this review began, except the scaling test/export/comment, integration expectations and report/manifest:

- Dockerfile/compose and edge Dockerfile: distinct opt-in worker, FFmpeg runtime, scratch ownership, non-root cache volume, resource/security constraints; preserve legacy command.
- Edge nginx/CORS/Caddy example/worker policy: private signed delivery, allowlist template, TLS routing example and restricted object permissions.
- `src/app.ts` and media routes: tenant-scoped control-plane registration/status/reprocess/playback endpoints.
- Media jobs/store/types/PostgreSQL/drafts/worker/processors/object keys and migration 0061: leased claims, immutable generations, atomic fenced publication, retry/recovery and sanitized failures.
- Playback token/URL/auth/origin/edge code and tests: generation-bound grants and origin signing, v1 compatibility and security regression coverage.
- Package scripts, media CDN fixtures/browser checks, control-plane/scaling/VPS tests: repeatable local release validation; held migration-runner validation dependencies must be resolved before a clean artifact is certified.
- Media documentation and read-only ledger inspection SQL: API contract, handoff history and operational review. Earlier handoff statements do not override the NO-GO gates in this report.
