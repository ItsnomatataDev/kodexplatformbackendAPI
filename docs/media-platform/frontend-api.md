# Media control-plane API (Milestone 2)

Base path: `/api/media-platform`. All endpoints use the existing Kode Bearer access token, active session, current organization membership and organization status. No alternative authentication system is introduced. Responses are `Cache-Control: no-store`.

Permissions use existing Content Studio policy: `content_studio.manage` for registration/processing and `content_studio.read` for status/variants/playback. Existing admin-role behavior is unchanged. Cross-tenant asset IDs return 404, and permission denial returns 403 before storage access. Session revocation is checked on each API call.

## Register an existing authorized video

`POST /assets`, permission `content_studio.manage`:

```json
{"sourceObjectKey":"<key from an existing authorized Content Studio upload>"}
```

This endpoint registers a source uploaded through the existing Content Studio upload flow. It does not accept arbitrary bucket names, organization IDs, user IDs, job types or remote URLs. Ownership is resolved through the existing tenant-scoped Content store before any origin HEAD request. Only nonempty `video/*` objects with known size up to 2 GiB in the configured Content bucket are accepted. Actual video validity is checked asynchronously by FFprobe/FFmpeg.

Returns 202 with `{ "asset": Asset }`. Asset creation and the initial HLS job are atomic. Repeated registration of the same source is idempotent and does not create duplicate initial jobs. A failed existing asset must be retried explicitly. Repeated registration still returns 202, even if the asset is already ready.

## Status and processing

`GET /assets/:assetId`, permission `content_studio.read`:

```json
{
  "asset": {
    "id": "<UUID>",
    "originalFilename": "video.mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 123456,
    "status": "processing",
    "playbackReady": false,
    "createdAt": "<ISO timestamp>",
    "updatedAt": "<ISO timestamp>",
    "errorCode": null
  },
  "jobs": [
    {"id":"<UUID>","type":"adaptive_hls","status":"processing","attempts":1,"maxAttempts":3,"errorCode":null}
  ]
}
```

Asset statuses: `uploading`, `uploaded`, `processing`, `ready`, `failed`, `deleted` (deleted assets are not returned). Job statuses: `queued`, `processing`, `completed`, `failed`, `cancelled`. At most the latest 20 jobs are returned. Client-visible failures use `MEDIA_PROCESSING_FAILED`; internal exception text, worker ownership and object keys are excluded.

`POST /assets/:assetId/process`, permission `content_studio.manage`, no body required: returns 202 `{ "job": Job }`. Concurrent requests reuse the existing queued/processing HLS job. After a terminal failure or successful publication it queues a new generation. A previous publication remains playable while its replacement processes or fails. Jobs serialize per asset; unrelated assets may process concurrently.

## Ready variants

`GET /assets/:assetId/variants`, permission `content_studio.read`: returns `{ "variants": Variant[] }`.

Each variant exposes only `id`, `kind`, `width`, `height`, `bitrateBps`, `codec`, `container`, `sizeBytes`, and `status`. Only variants belonging to currently published HLS/MP4 generations are returned. Drafts, failed attempts and superseded generations are hidden. HLS `sizeBytes` is aggregate rendition storage, not just the playlist size. No private bucket/object key or direct origin URL is returned. Lower-resolution sources may have fewer than three renditions; do not assume 1080p always exists.

## Playback grant

`POST /assets/:assetId/playback`, permission `content_studio.read`, no body required:

```json
{"assetId":"<UUID>","playbackUrl":"<HTTPS signed edge URL>","expiresAt":1234567890}
```

`expiresAt` is Unix seconds. New grants expire in 300 seconds and authorize exactly the published HLS generation. Relative master/rendition/segment URLs keep the signed prefix. The frontend must use the returned URL verbatim and renew before expiry (for example, 60 seconds beforehand); never derive origin paths, generate signatures, log grants or put them in analytics. How the selected player switches to a renewed master must be browser-tested before integration.

The API issues metadata/grants only; Nginx delivers media bytes. The edge checks HMAC authorization before every cache hit. A generation or asset ID cannot be changed without invalidating the signature.

**Revocation boundary:** revoked sessions/memberships/permissions immediately prevent new API access and grant renewal. Already-issued grants are bearer capabilities and remain valid until their five-minute expiry. The edge does not call the API/database to re-evaluate session or permission state per segment. If immediate revocation is a product requirement, this remains a release blocker; it is not claimed as implemented.

Configuration required for issuance: matching strong `MEDIA_PLAYBACK_SIGNING_SECRET` on API/auth and `MEDIA_PLAYBACK_PUBLIC_BASE_URL` as an HTTPS origin with no path/query/credentials. The base URL is never taken from a client request or Host header. Only the HLS playback endpoint is exposed; ready MP4 metadata is available but there is no new MP4 grant route.

## Errors and integration gates

The normal Kode `{ "error": { "code", "message", ... } }` envelope applies:

- 400 `VALIDATION_ERROR`: malformed IDs/input, disallowed fields, unsupported source metadata.
- 401: missing/expired authentication or inactive session.
- 403: current permission, membership, account or organization policy denial.
- 404 `MEDIA_ASSET_NOT_FOUND`: absent/cross-tenant/deleted asset or unauthorized source.
- 409 `MEDIA_NOT_READY`: no published HLS generation yet.
- 503 `MEDIA_PLAYBACK_UNAVAILABLE`: signing/public-origin configuration missing or invalid.

Poll processing status with backoff; do not repeatedly enqueue as a polling mechanism. Requests remain subject to shared API body/security middleware; media-specific capacity/rate tuning is still an operational task. Private origin addresses, signing credentials, lease fields and raw processing errors are never part of the DTOs.

Before frontend work: reconcile the actual migration ledger through an approved rollout, deploy/test the separate fenced worker, confirm grant-revocation policy, validate public-host CORS and native Safari/MSE playback/seeking/renewal, and verify rollback. These endpoints passing local tests does not establish production/frontend readiness.

## Milestone 3 browser and grant policy

A local Chrome/hls.js test now decodes HLS from a separate page origin through the real private MinIO/auth/Nginx path. Master, rendition, init and media segments load; expired grants return browser-readable 403 responses; a newly signed grant restores requests. This is not yet a seamless in-player renewal/seeking test or a native Safari qualification. No frontend application files changed.

Production recommendation: retain the explicit **300-second control-plane grant TTL**, renew about 60 seconds before expiry, and require documented acceptance of up to five minutes of continued access after permission/session revocation. Shorter grants reduce that window but increase renewals and playback interruption risk. High-sensitivity deployments should evaluate 60–120 seconds; any requirement for immediate revocation needs a stateful edge authorization check or revocation/version mechanism before release. TTL changes alone cannot provide it. Buffered/downloaded bytes remain accessible after expiry, and requests admitted just before expiry can finish. Expiry applies to each new playlist/segment request, not to erasing data already delivered. Other/legacy signing callers can have different TTLs; do not infer a universal retention cutoff from this API's five minutes.

The edge allowlist is `deploy/media-edge/media-cors.conf`, shipped empty (cross-origin deny). Configure exact approved HTTPS page origins; no wildcard, arbitrary reflection, `null` origin or cookies. The browser requests media with credentials omitted. GET/HEAD always require a valid grant even when cached; OPTIONS returns only CORS metadata, never media. Allowed origins can read 403/502 responses to distinguish authorization/outage failures. CORS controls browser access and is not tenant authorization: a holder of a valid bearer URL can use a non-browser client. Grants must stay out of logs, analytics and shared links. Deploying the correct allowlist and HTTPS media hostname remains an operational gate.
