# Private CDN audit and integration handoff

Audit date: 2026-10-08. Branch: `fix/private-media-cdn-readiness`.
Baseline: `1d88a0d`. Status: **blocked on missing implementation; not ready for frontend integration**.

## Repository evidence

The supplied deployment description does not match this checkout:

- `deploy/media-edge/nginx.conf` is absent; Compose has no media-edge or media-auth service.
- `src/media-platform/` contains only a pre-existing untracked `playback/token.ts`.
- No `media_platform` schema, job leases, variants, HLS encoder or origin signer exists here.
- Migration `0058_time_entry_auto_stop.sql` belongs to time entries. There is no 0059. Do not overwrite or reuse migration numbers.
- The media-worker Docker target runs `dist/content/playback-worker.js`: an MP4 scanning worker using a PostgreSQL session advisory lock, not leased media jobs.
- API and worker use host networking. MinIO is on the Compose default network and publishes loopback ports. There is no Caddy service in this Compose file.
- Existing Content Studio routes implement opaque media capabilities. They are not the proposed HMAC HLS contract.

No live VPS access, production mutation, migration, deployment, frontend change or secret inspection was performed. Existing password HTML edits and the untracked token implementation were preserved. Docker is available locally, but an invented substitute service would not validate the missing implementation.

Required input: the branch/commit or local source snapshot containing the deployed media-edge, media-auth, origin signer, schema, processor, and their tests. Reconcile it with this branch before implementing configuration against its real contract.

## Changes and local validation

Added `tests/media-playback-token.test.ts`: round trip, UUID normalization, asset/expiry/signature tampering, key mismatch, expiry boundary, malformed identifiers and expiry values. This exercises only the supplied token helper, not HTTP authorization or tenant ownership.

Run:

```sh
node --import tsx --test tests/media-playback-token.test.ts
npm run typecheck
npm test
```

Results are recorded below after execution. These checks cannot establish CDN readiness.

## Repair design once source is available

For the reported variable origin proxy, put these directives in the edge `http` or `server` context on a Docker user-defined network:

```nginx
resolver 127.0.0.11 valid=30s ipv6=off;
resolver_timeout 5s;
```

Keep the original signed URI byte-for-byte, including escaping and query ordering; never append client arguments. Set the upstream Host to the exact authority signed by media-auth (including port). If that authority is `minio:9000`, use `proxy_set_header Host minio:9000`. Do not apply this assumption to an unseen signer. Sign the actual GET/HEAD method, or deliberately normalize HEAD to a signed GET and verify that behavior. Reject arbitrary upstream hosts, bucket selection, traversal, duplicate token parameters, encoded separators and unexpected object suffixes before origin access.

Nginx documents runtime name resolution for variable proxy targets in its [proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass). Its [auth request module](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html) permits access on a successful auth subrequest; denial must run before cache serving too.

HLS relative children do not inherit a master URL query token. Inspect the actual implementation: use a scoped path capability, deliberately rewritten child URLs, or a browser-compatible cookie scheme. Do not simply attach a query signature to the master and assume child requests are authorized. Scope every child to the authorized asset and immutable generation.

## Proposed cache and security policy (not implemented)

- Authenticate every GET/HEAD, including cache hits; never cache auth responses or serve stale authorization. Auth outage fails closed.
- Key by trusted origin namespace, bucket, full canonical object key and immutable generation. Exclude short-lived signatures only after successful authorization. Test cross-tenant and cross-asset separation.
- Cache successful VOD masters/renditions for 30 seconds initially; immutable versioned init/segments for 24 hours, inactive eviction after 7 days. Never cache 401/403/404/5xx or partial 206 responses initially. Bypass cache for Range requests until tested; verify 206/416, Content-Range and If-Range semantics.
- Start with a 2 GiB disk cache and 16 MiB metadata zone; use a dedicated writable cache volume and tmpfs for PID/temp directories with a read-only root filesystem. Nginx eviction is asynchronous: disk headroom and a volume quota/monitoring are still needed.
- Use cache locking to limit origin stampedes. Keep browser responses `Cache-Control: private, no-store` initially; server caching must be configured separately. This costs browser reuse but preserves request-time authorization. Already downloaded bytes cannot be revoked.
- Hide origin signing headers, redirects, storage error XML and SigV4 query strings. Return generic failures. Do not expose the origin URL through debug headers.
- Access logs must omit URI, query, Referer, cookies and authorization. Nginx error logs can include request/upstream URLs even at error severity: validate a redacting sink or disable request-bearing error output; lowering verbosity alone is insufficient.
- Dedicated media-auth credentials: GetObject only on the playback prefix, no root credentials, list/write/delete/admin grants. Worker gets separately scoped read/write credentials. Keep MinIO private and generic service settings unchanged.
- Separate edge/auth networking; no public auth or origin ports. Edge needs only auth and origin reachability. Provision secrets independently of broad API env files. Plan overlapping verification keys with a bounded retirement window; signer currently has no key identifier or rotation implementation.
- Initial edge limits: 0.5 CPU, 256 MiB, 128 PIDs; tune under load. Suggested connect timeout 5s, read timeout 30s, bounded auth timeout. Test capacity and large MP4 buffering before adopting.
- Inspect real job lease renewal, retry limits, fencing, shutdown and orphan cleanup. Crash/restart and two-worker tests must prove stale workers cannot publish over newer jobs. The existing advisory-lock worker does not establish these guarantees.

## Future Caddy routing

The following is a separate proposed site block, **not an applied configuration**. Replace the reserved hostname and confirm Caddy's actual topology first. `media-edge:8080` assumes a future shared Docker network and listening port; host Caddy requires a separately reviewed loopback upstream instead.

```caddyfile
media.example.invalid {
    header {
        -Server
        Referrer-Policy no-referrer
        X-Content-Type-Options nosniff
    }
    reverse_proxy media-edge:8080
}
```

Do not enable URI-bearing access logs for capability routes. Review global error logging/redaction too. No API playback route changes. Cross-origin browser use requires an explicit approved frontend origin, Vary: Origin where applicable, GET/HEAD/OPTIONS policy, and exposed Range headers; verify Safari native HLS and the frontend's chosen HLS player before enabling the site.

## Controlled deployment and rollback gates

Do not execute deployment commands against this incomplete checkout. Once real code is reconciled and isolated end-to-end tests pass, seek explicit infrastructure deployment approval.

1. Record deployed commit, image digests, edge/auth configuration and network topology in restricted operator storage. Never print `.env.vps`, `docker compose config`, container environment or signed URLs.
2. Review migration identity collisions and service-specific secrets. No migration is authorized by this handoff. Build/test the reconciled commit in an isolated Compose project with disposable private MinIO, PostgreSQL, auth and edge containers.
3. Test actual HTTP delivery using an in-process client that retains capabilities only in memory and prints status, MIME, cache status and byte comparisons. Avoid curl command lines, verbose HTTP logs and shell tracing with signed URLs.
4. After approval and confirming these service names exist, validate syntax and recreate only the two delivery services, never the API or generic data services:

```sh
cd /opt/kode-platform
docker compose --env-file .env.vps -f docker-compose.vps.yml --profile media run --rm --no-deps media-edge nginx -t
docker compose --env-file .env.vps -f docker-compose.vps.yml --profile media up -d --no-deps media-auth media-edge
```

These are conditional operator commands, not runnable deployment instructions for the current checkout. Supply the actual integration runner from the recovered implementation before approving rollout. Do not use syntax success or `/health` as release evidence.

5. Repeat the matrix below on the private edge. Public Caddy routing is a separate approval/change after private validation. Monitor aggregate errors, auth latency, cache hit rate, disk and origin traffic without capabilities in telemetry.
6. Rollback: restore only captured edge/auth config and pinned images, then recreate those services with `--no-deps`. If a separately approved Caddy block was enabled, remove that block and validate/reload Caddy. Keep original API routes, MinIO objects, database and volumes intact. Version the cache namespace when object mapping changes; never prune Docker or remove shared volumes.

## Frontend API contract to finalize

There is no implemented private-CDN API contract in this checkout. Do not code the frontend against invented endpoint names. The recovered control plane must document:

- Asset create/upload/finalize endpoints, tenant authorization, size/type limits, idempotency, and upload expiry.
- Asset status response: stable ID, queued/processing/ready/failed state, processing error code, available renditions, duration/dimensions and immutable generation.
- Playback issuance endpoint: authenticated tenant ownership check, ready-state handling, HTTPS master URL, absolute expiry, renewal behavior and allowed delivery methods. Responses containing capabilities must be no-store.
- How child playlists/segments carry authorization, CORS/cookie requirements, session revocation policy, rotation and clock skew.
- Errors for unauthenticated/forbidden/not-found/not-ready/rate-limit/unavailable, retry guidance and correlation IDs without secrets.

API issues metadata and playback grants; edge delivers all HLS bytes. Existing Content Studio capability endpoints remain unchanged.

## Exact readiness evidence checklist

All currently unverified for the private CDN unless explicitly stated:

- [ ] Actual implementation recovered; migration numbering reconciled.
- [ ] Valid master and 1080p/720p/480p playlists return 200; parse and recursively fetch all relative children.
- [ ] Init and segments match uploaded bytes; MIME types are correct (playlists application/vnd.apple.mpegurl, MPEG-TS video/mp2t or fMP4 video/mp4 as appropriate).
- [ ] Browser playback/seeking works in Safari and the chosen MSE player; no origin URLs or credentials are observable.
- [ ] Missing/invalid/expired/tampered and cross-asset tokens fail cold AND warm; origin request counts stay unchanged on rejection.
- [ ] Anonymous MinIO reads remain denied; no public bucket policy.
- [ ] First request MISS, second HIT; expiry is still denied after warming. Distinct buckets/assets/generations never collide.
- [ ] Auth failures and origin errors are uncached; auth outages fail closed even for warm objects.
- [ ] Range/HEAD/If-Range/416 verified, with correct length and content headers.
- [ ] Origin DNS IP changes recover; signed authority and escaped URI verified against real MinIO.
- [ ] Read-only filesystem, cache capacity/eviction, concurrency, timeouts and worker recovery tested.
- [ ] Logging checked under denial, origin outage and malformed paths; no secrets/capabilities leak.
- [ ] Least-privilege credentials, network isolation and rotation exercised.
- [ ] Existing playback regression tests pass; no API video streaming added for HLS.
- [ ] Approved deployment/rollback rehearsed; public routing separately approved.

Do not declare production readiness until these HTTP and operational checks have recorded results.
