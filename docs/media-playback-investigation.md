# Media playback investigation — 2026-09-28

## Findings and limits

The production incident's root cause is **not established**. No production
request logs or live proxy configuration were available during this investigation.
Do not describe the change below as a verified fix for production stuttering.

Single-use capabilities are ruled out for this checkout: both
`MediaCapabilityStore.consume` and `RedisMediaCapabilityStore.consume` read
without deleting. The staff issuance route explicitly sets a one-hour absolute
TTL. Existing tests verify expiry, object/organization scope, ownership checks,
Redis namespace separation, and fail-closed Redis outages. New mounted-route tests
exercise sequential ranges, forward/backward seeking, suffix/open-ended/clamped
ranges and malformed/out-of-bounds requests with the same issued URL.

A separate, concrete storage lifecycle defect was reproduced: `getObjectStream`
discarded 404, 416 and other error response bodies without consuming or cancelling
them. Three tests failed before the change and passed after explicitly cancelling
these bodies. Leaving bodies unread can retain upstream connection resources;
its contribution to this incident remains unproven. Successful media responses
still stream directly, without buffering or duplicate storage GETs.

## Architecture and environment comparison

The adjacent frontend repository's `ContentReviewVideo.tsx` uses native video
`src`. `ContentSecureMedia.tsx` retains a stable resolved URL.
`contentReviewMediaUrl.ts` caches staff capabilities with a five-second expiry
margin and deduplicates pending issuance requests; no manual chunk fetch is used.
Staff URLs are issued by authenticated `POST /api/content-studio/media/capability`,
which checks organization ownership. Native `GET /api/content-studio/media`
validates the capability and rechecks ownership, then calls `streamStoredMedia`
and `MinioFileStorage.getObjectStream`. MinIO receives the Range header in a
signed GET. Status, Content-Range, Content-Length and MIME type are forwarded;
416 is returned with an empty body. MinIO is responsible for parsing actual storage
ranges; memory-adapter range tests do not prove live MinIO behavior.

Portal and internal-preview URLs use separate session/review authorization in
`content-portal.ts` and `content-preview.ts`, sharing the streaming helper.
The new staff authorization diagnostics do not cover those authorization paths.

Development uses process-local capabilities; staging/production use Redis.
Production guards require HTTPS storage; a custom CA selects the `https.request`
transport, otherwise storage uses fetch. Both streaming transports avoid full
object buffering. The VPS compose example uses staging and loopback services;
the production compose file describes a different TLS topology. Neither proves
what is deployed. The Caddy example enables gzip on general routes and has long
timeouts specifically for binary uploads. Live encoding, Range forwarding,
proxy buffering, storage latency, deployed revisions and CDN behavior still need
verification. No proxy or authorization settings were changed.

## Safe diagnostics retained

Existing request logs contain method, path, status and handler duration, but not
Range or body completion. The staff media route now also emits:

- `media.authorization` for invalid/expired grants or missing ownership;
- `media.storage` with authorization time, storage response-header time, status,
  Content-Range, Content-Length and Accept-Ranges;
- `media.stream` with complete/aborted/error outcome, bytes pulled and duration.

Correlate by existing requestId, SHA-256 playbackId and mediaId. No query strings,
raw capabilities, object names, cookies, tokens or stream error details are logged.
Range values are restricted to bounded numeric byte syntax before logging.
Reads do not expose whether a missing capability expired or never existed.
Stream completion means the API consumed the upstream body, not that the browser
rendered every frame. The observer preserves backpressure and forwards cancellation.
Retain these logs for the production investigation; evaluate volume/retention
once a failing session has been captured.

## Verification

- Before fix: storage regression tests — three failures for uncancelled bodies;
  successful range/cancellation test passed.
- Focused route/storage/reliability tests — 29 passed.
- `npm run build` — passed.
- `npm run typecheck` — blocked by existing TS2835 in
  `scripts/migration/repair-leave-history.ts:2` (missing `.js` import extension).
- Full suite in restricted sandbox — 236 passed, 9 skipped, four SMTP tests
  failed because local socket listeners were denied.
- `npm test` with local socket access — 240 passed, 9 skipped, zero failures.
- `git diff --check` — passed. No lint script is configured.

## Production follow-up required

Capture a failing staff session through the actual proxy, including sequential
and non-sequential seeks. Correlate safe diagnostic IDs to distinguish 403/expiry,
slow storage headers, slow/erroring bodies and normal browser seek cancellations.
Compare against direct API requests with the same Range headers. Check deployed
backend/frontend revisions, Redis availability, object codec/index placement and
proxy response headers. Do not export capability-bearing request URLs or raw HAR
files. Live MinIO/proxy and browser playback verification remain outstanding.
