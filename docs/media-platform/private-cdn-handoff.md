# Private CDN engineering handoff — Milestone 1 archive

> Current implementation, migration reconciliation, fencing and API contract: [Milestone 2 handoff](milestone-2-handoff.md). The report below preserves Milestone 1 findings; its migration/worker/API blockers are superseded by that report.

2026-10-08 · branch `fix/private-media-cdn-readiness`

**Local private-origin delivery verified; production/frontend readiness remains gated.** No VPS connection, deployment, production restart, data mutation, secret access, frontend change or replacement of the existing Content Studio playback implementation was performed.

## Audit and changes

The initial audit found missing source. The user subsequently synchronized the VPS implementation; this document supersedes that initial missing-source assessment. Existing tests and documentation were reviewed before modification.

| Files | Change/purpose |
| --- | --- |
| `deploy/media-edge/nginx.conf` | Docker runtime DNS for origin and auth; preserve signed URI and `Host: minio:9000`; GET/HEAD only; timeouts; sanitized logging; private authenticated cache; bounded storage; safe origin errors |
| `deploy/media-edge/Dockerfile` | Prepare cache directory ownership for UID 101 on a read-only container |
| `docker-compose.vps.yml` | Build edge image, dedicated cache volume, edge CPU/memory/PID limits, dedicated read-only media-auth credential variables |
| `src/media-platform/playback/auth-server.ts` | Hash canonical origin authority/path for cache identity; require signer authority matching the edge; bounded incoming HTTP requests; generic signing errors without raw exception text |
| `src/media-platform/playback/auth-server.test.ts` | Cache identity and authority mismatch regression tests, preserving existing cases |
| `src/media-platform/processing/adaptive-hls.ts` | Correct landscape 1080p dimensions (previously 1080 pixels on the long edge); use peak configured bandwidth; omit inaccurate hard-coded codec-level declaration; cap encoder threads; check abort before master publication |
| `src/media-platform/processing/ffmpeg.ts` | Allow only file/pipe protocols for input probing/encoding; suppress raw FFmpeg error text that could contain source data |
| `src/media-platform/processing-worker.ts` | Abort work when lease heartbeat cannot be renewed, instead of continuing indefinitely through DB errors |
| `tests/media-cdn/` | Disposable MinIO/Nginx/auth/FFmpeg/PostgreSQL integration harness with synthetic credentials and cleanup |
| `tests/vps-deployment.test.mjs` | Add new media variables to existing dummy Compose credentials; no real env file is read |
| `package.json` | Add `test:media` and `test:media:integration` commands |
| `deploy/media-edge/Caddyfile.example` | Unapplied future host-Caddy media routing proposal |

The imported Dockerfile still starts the legacy Content worker for `media-worker`; it was deliberately not repointed. The new processing worker is not wired into that service. Imported migrations were not modified or applied outside the disposable test database.

## Delivery and authorization contract

`createMediaPlaybackUrl({ assetId, secret, now?, ttlSeconds?, basePath? })` creates a path with the following shape (placeholders, never a real capability):

```text
/media/v1/{unixExpiry}/{HMAC-SHA256-base64url}/{assetUuid}/hls/master.m3u8
```

Default lifetime is one hour. The signature covers `v1`, normalized UUID and expiry separated by newlines. Expiry is exclusive. It authorizes the asset's supported HLS children, not an arbitrary bucket/path. Relative links preserve the signed path prefix. Supported children are `1080p`, `720p`, `480p` rendition `index.m3u8`, `init.mp4`, and `segment_00000.m4s`-style five-digit segments. Queries, encoded path tricks and unsupported suffixes are rejected by the strict verifier.

Edge makes an internal GET `/authorize` with `X-Original-URI`; media-auth verifies the HMAC and returns a 60-second MinIO presigned GET URI in an internal response header. Object mapping is `content-review-assets/.media/v1/{assetUuid}/{objectPath}`. Origin authority is `http://minio:9000`; changing it requires a coordinated signer/edge change. The edge proxies the URI unchanged with the matching Host. Client HEAD uses a signed origin GET, with Nginx omitting the response body. Browser requests never receive the MinIO URL or signer headers.

The edge serves 403 for denied capabilities, 404 for missing objects, 405 for unsupported methods, 416 for invalid ranges, and generic 502 for auth/origin service failures. It strips origin XML error bodies and redirects. A generic 416 currently omits the origin Content-Range header; successful 206 responses retain range headers. `/health` proves process liveness only.

The API remains the control plane. No HLS bytes were added to API routes.

## Cache design and tradeoffs

Authentication runs in Nginx's access phase on **every** request, before cache lookup, including HIT. Auth responses are never cached. Missing cache identities bypass caching. Cache identity is SHA-256 of the signer-produced origin authority plus canonical object path, including bucket and full key; signature/expiry changes do not fragment cache. The signer cannot choose a different authority. Client-supplied cache or signing headers are not forwarded.

Only full successful 200 responses are stored. Range requests bypass cache and are not stored. Errors are not cached. No stale serving is enabled. Locking reduces duplicate fills. Origin cache metadata is ignored so it cannot lengthen freshness or trigger internal redirects. Browser responses are `private, no-store`; bearer links should also be excluded from frontend analytics, error reports and browser history where possible.

**All objects currently have a conservative 30-second TTL.** Master/rendition playlists and segments use fixed keys that retries can overwrite. Calling these segments immutable or giving them a day-long TTL would be unsafe. Once publication uses immutable generation keys and is fenced, use short playlist TTLs and longer segment/init TTLs. Even the current short TTL can mix generations during reprocessing: do not reprocess a published asset ID until this is fixed.

Cache metadata is bounded to 16 MiB, disk target 2 GiB, inactive eviction 24 hours; the dedicated volume is writable under UID 101. Eviction is asynchronous, so monitor free disk and use external filesystem quotas if hard limits are required. No eviction/load benchmark was performed. Edge uses one worker, 0.5 CPU, 256 MiB and 64 PIDs. Performance tuning requires representative load.

Access logs contain only status, method, byte count, timing, cache status and upstream address. Nginx error logs are disabled because even error-level messages can include bearer paths and SigV4 URLs. This sacrifices detailed production diagnostics: use status/latency/health monitoring, and reproduce errors locally with disposable credentials. Never enable verbose request logging on real traffic without redaction.

References: [Nginx variable proxy resolution and caching](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [auth subrequests](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html).

## Isolation, credentials and dependencies

Media-auth remains on the internal `media-private` network with no host port and needs no MinIO network access: presigning uses a fixed region locally. Edge joins that network plus the existing default network to reach MinIO; its host publication stays loopback-only (`127.0.0.1:3100`). Existing MinIO networking and credentials used by other services were not changed. The default network is shared with other infrastructure; stronger dedicated origin segmentation is a future coordinated change.

Provision separate `MEDIA_ORIGIN_ACCESS_KEY` and `MEDIA_ORIGIN_SECRET_KEY` for media-auth, with only `s3:GetObject` on `arn:aws:s3:::content-review-assets/.media/v1/*`. No root, listing, writes, deletes or public bucket policy. Integration tests use this exact policy. Never send real credentials to chat or copy them into fixtures. Generate a strong independent playback secret (at least 32 random bytes) in operator-managed secret storage. Compose environment variables remain visible to privileged Docker operators; Docker/file secret integration is not implemented.

Rotation: deploy new read-only origin credentials to auth, verify delivery, then revoke old credentials. Playback signing supports only one active secret; changing it invalidates all outstanding links immediately, including cached requests. Graceful overlapping signing-key rotation is not implemented. Coordinate issuer/auth rotation and grant renewal; do not silently broaden verification.

`npm audit --omit=dev` reported 4 moderate findings: MinIO and transitive `decode-uri-component`, `query-string`, `stream-json`; no high/critical findings in that report. Suggested automated remediation downgrades MinIO across a major version; it was not applied without compatibility review. Container image tags remain mutable and should be pinned to reviewed digests for a release. FFmpeg build success is not an OS vulnerability audit.

## Validation

Run from the repository:

```sh
npm run typecheck
npm run build
npm run test:media
npm test
npm run test:media:integration
```

The integration command requires a local Unix-socket Docker context, rejects `DOCKER_HOST`, uses a unique Compose project and `--env-file /dev/null`, publishes no ports, and removes only its disposable project/volumes on exit. It never touches the VPS stack. It builds actual production code/images and uses a GetObject-only origin principal. Do not enable shell tracing. Test failures suppress unknown error details to avoid printing capability URLs.

Verified locally:

- 58 playback/token/auth/signer unit tests passed.
- TypeScript typecheck and build passed.
- Real FFmpeg encoded a 1920x1080 source into all three HLS renditions; real MinIO stored and authorized every object; real Nginx delivered master, rendition playlists, init files and segments byte-for-byte with correct MIME types.
- 88 HTTP/processing checks passed, including relative child URLs, cache MISS/HIT, wrong/expired/malformed tokens, actual token expiry after warming, Range 206 and 416, HEAD, anonymous origin denial, reader write denial, and no caching of missing-object errors.
- Sanitized edge logs showed denied requests had no origin upstream; no bearer paths/SigV4 strings appeared.
- Stopping auth denied access to a warm cache with 502.
- Real PostgreSQL 17 tests passed for concurrent claims, heartbeat, wrong/stale-owner rejection, lease expiry recovery and exhausted retries.
- Existing Compose fixture initially failed due to missing new dummy media variables; after fixing that fixture, its four tests passed. Final `npm test`: 251 passed, 10 skipped, zero failures (261 total).

The database test applies only the media SQL in a fresh database with minimal FK prerequisite tables. It does **not** validate the repository-wide migration sequence or full worker lifecycle. Browser playback, CORS, audio/portrait/variable-frame-rate coverage, DNS container-recreation recovery, load, eviction and production delivery remain unverified.

## Release blockers and remaining work

1. **Migration collision:** both `0058_time_entry_auto_stop.sql` and `0058_media_platform.sql` exist. The migration runner requires consecutive unique numbers and tracks only the version. Reconcile deployed migration history through an operator-reviewed plan before running any migrations. No safe renumbering can be inferred from this checkout alone.
2. **Publication fencing:** DB completion is owner/expiry fenced, but variant/status/object writes are not. Duplicate jobs can overwrite the same keys; stale uploads already in flight can complete after lease loss. Add immutable generation/attempt keys and transactional publication, with recovery/cleanup tests. Current heartbeat abort is defense in depth, not complete fencing.
3. **Worker integration/resources:** Compose starts the legacy worker, not `processing-worker.js`. Introduce a separately reviewed service rather than replacing legacy playback. The existing worker's 4 GiB tmpfs ceiling exceeds its 1.5 GiB memory limit; 2 GiB sources plus derivatives can OOM. Size disk-backed scratch and CPU/thread budgets for representative workloads. FFmpeg protocol restriction blocks network fetches, but file access still needs container isolation. Thumbnail/metadata jobs are intentionally unimplemented.
4. **API control plane absent:** media asset/job store methods and URL helper exist, but no mounted media-platform create/status/grant routes exist. Tenant-checked grant issuance must precede frontend integration. The edge is bearer-only and does not consult asset deletion, tenant membership or session revocation; cached objects remain accessible with an unexpired valid grant even after deletion. Define revocation semantics before launch.
5. **Browser delivery:** actual native Safari/HLS player tests and an explicit allowed-origin CORS policy are still required for a distinct public media hostname. No wildcard CORS or temporary bypass was introduced.
6. **Operational validation:** least-privilege production principal provisioning, key rotation rehearsal, disk quotas/monitoring, rate/load limits, dependency review and image digests remain release gates.

## Proposed deployment (approval required; not executed)

Treat delivery-only rollout and worker/API/schema rollout as separate changes. The commands below are for an authorized operator after blockers relevant to that rollout are resolved; they are not instructions to migrate or restart API.

1. Save current edge/auth image digests and reviewed source/config snapshots to restricted operator storage. Record cache volume names, old credential references and the old Compose file. Do not capture expanded config or environment dumps in logs.
2. Provision the read-only media origin principal via the approved secret-management process. Set the new media-only variables on the host without exposing values. Preserve generic MinIO settings.
3. Run all local validation above; review the two edge/auth services and migration collision. Do not run `npm run migrate` in this state.
4. After explicit infrastructure approval, on the VPS with the reviewed source:

```sh
cd /opt/kode-platform
docker compose --env-file .env.vps -f docker-compose.vps.yml --profile media config --quiet
docker compose --env-file .env.vps -f docker-compose.vps.yml --profile media build media-auth media-edge
docker compose --env-file .env.vps -f docker-compose.vps.yml --profile media run --rm --no-deps media-edge nginx -t
docker compose --env-file .env.vps -f docker-compose.vps.yml --profile media up -d --no-deps media-auth media-edge
```

A previously created root-owned cache volume may require an approved one-time permission repair; use the new dedicated volume by default. Do not repurpose shared volumes. Auth/edge updates can temporarily fail closed; schedule an appropriate delivery maintenance window. No API, legacy worker, PostgreSQL, Redis or MinIO recreation is included.

5. Validate actual private edge HTTP with a controlled existing fixture and a client that keeps signed paths in memory: all renditions/children, MIME/bytes, warm-cache expiry/denial and Range. Record only statuses/check names. The included integration runner is intentionally hard-wired to disposable fixtures and **must not** be pointed at production (it creates/deletes fixture objects).
6. Public routing is a separate approval. Review `deploy/media-edge/Caddyfile.example` against the real Caddy topology. It assumes host Caddy and uses loopback port 3100. Resolve CORS and logging first; validate Caddy config before any separately approved reload. Do not touch the current Content Studio route.

## Rollback

Before rollout, prepare a small rollback Compose override with captured immutable edge/auth image references. Keep the previous Compose/env references and Nginx config together: the old auth image expects the old credential variable names. Restore only those reviewed delivery files/references, then recreate only edge/auth with `--no-deps --no-build` using the captured image override. Validate actual HTTP, not just health. Roll back a separately approved media Caddy block independently if applicable.

No schema rollback, object deletion, volume removal, generic credential rotation, API restart or Docker prune is part of rollback. Leave the new cache volume intact; use a new cache namespace/volume when object mapping semantics change. Reverting DNS to the known-broken config reintroduces 502, so prefer retaining the tested DNS-only correction in a reviewed fallback image/config.

## Frontend backend contract and readiness checklist

Implemented delivery contract is above. The following control-plane surface is **required/proposed, not mounted endpoints**:

| Operation | Required behavior |
| --- | --- |
| Create/upload/finalize asset | Authenticated organization scope, source ownership, size/type limits, idempotency, upload expiry; return stable asset ID |
| Read asset status | Tenant authorization; status, available variants/dimensions/duration, supported processing failures; no raw internal exception messages |
| Issue/renew playback grant | Tenant ownership and ready-state check; return `{ assetId, playbackUrl, expiresAt }` with HTTPS edge URL and Unix-seconds expiry; no-store response; never return secret or origin URL |
| Delete/revoke | Define whether existing grants expire naturally or are checked against revocation state before cache access |

Specify exact endpoint names and error envelope when implementing the routes. Require 401/403/404 distinctions, not-ready handling, 429/retry guidance, renewal ahead of expiry and correlation IDs without URLs. The frontend must never generate signatures, derive origin keys or stream HLS through the Kode API.

- [x] Local private-origin HTTP delivery, all HLS object types, correct MIME/bytes/relative paths.
- [x] Local authorization before cache hits, expired/invalid denial, no origin access for denial.
- [x] Private bucket and read-only signer credentials exercised locally.
- [x] Bounded cache configured on read-only container with writable dedicated volume.
- [x] Local FFmpeg encoding and PostgreSQL job lease behaviors exercised.
- [ ] Migration histories reconciled without changing already-applied semantics.
- [ ] Publication fencing/immutable generations and full worker crash recovery validated.
- [ ] Separate new-worker deployment and scratch-memory sizing reviewed.
- [ ] Tenant-authorized asset/status/playback grant API implemented and tested.
- [ ] Revocation and signing-key rotation semantics agreed and tested.
- [ ] Browser HLS/CORS/audio/portrait compatibility verified.
- [ ] DNS recreation, cache eviction/load, dependency and operational review complete.
- [ ] Approved delivery deployment/rollback rehearsed and actual production private-edge HTTP verified.
- [ ] Public media routing separately reviewed and approved.

**Do not label the backend frontend-ready until the unchecked gates are resolved.**
