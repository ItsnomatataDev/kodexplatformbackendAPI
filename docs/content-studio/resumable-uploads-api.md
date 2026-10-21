# Content Studio resumable uploads — API and operations

The resumable uploader is additive to existing Content Studio binary and
JSON/Base64 uploads. It stores private MinIO multipart data and finalizes the
same `content.schedule_assets` / `content.client_media` records used by the
existing playback worker. Upload completion does not mean that a video is
playback-ready.

`CONTENT_STUDIO_RESUMABLE_UPLOADS_ENABLED` defaults to `false`. Keep it disabled
until the frontend client, deployed proxy path, and disposable-MinIO validation
are ready. Existing authenticated sessions remain available for status, parts,
retry, completion, and cancellation while new-session creation is disabled.

## Authorization and protocol

All endpoints use the authenticated Kode bearer session, the global CSRF
middleware, and `content_studio.manage`. Each operation checks current
organization/target access and binds the session to its original uploader.
Session IDs do not grant access. Organization, bucket, object key, multipart
upload ID, ETags, and the completion manifest are server-controlled.

The raw part body is streamed directly to MinIO and is not passed through the
general text-body buffer. `Content-Length` and the actual stream length must
equal the expected size for that part. The first part also receives a bounded
media-signature check. Non-final parts are at least 5 MiB. The server reconciles
the provider's committed parts with PostgreSQL before returning progress and
before completion.

## Requests and responses

Base path: `/api/content-studio/uploads`

### Create a session

`POST /sessions` — JSON; exactly one target identifier is required.

Schedule request:

```json
{
  "scheduleId": "00000000-0000-4000-8000-000000000001",
  "filename": "campaign-video.mp4",
  "mimeType": "video/mp4",
  "fileSizeBytes": 327155712,
  "displaySlot": 0,
  "heading": "Campaign",
  "caption": "Launch video"
}
```

Client-library request:

```json
{
  "clientId": "00000000-0000-4000-8000-000000000002",
  "officeId": "00000000-0000-4000-8000-000000000003",
  "filename": "reference.jpg",
  "mimeType": "image/jpeg",
  "fileSizeBytes": 7340032,
  "label": "Reference"
}
```

The server resolves the organization from auth, the schedule's office from the
stored schedule, and the client office from the current membership or supplied
office ID after organization-scoped lookup.

Success is `201 Created` with `{ "session": { ... } }`. If the database session
was persisted but MinIO initiation is uncertain, the server returns
`202 Accepted` with the session in `initiating` state; retain the session ID,
poll status, and do not create a duplicate session. The maintenance job repairs
orphaned initiation requests.

Public session fields:

```json
{
  "sessionId": "opaque UUID",
  "state": "uploading",
  "targetType": "schedule_asset",
  "fileName": "campaign-video.mp4",
  "mimeType": "video/mp4",
  "fileSizeBytes": 327155712,
  "partSizeBytes": 8388608,
  "partCount": 39,
  "expiresAt": "ISO-8601 timestamp",
  "committedParts": [
    { "partNumber": 1, "sizeBytes": 8388608 }
  ]
}
```

No provider multipart ID, bucket, object key, secret, or ETag is returned.

### Inspect progress and resume

- `GET /sessions/:sessionId` → `{ "session": PublicUploadSession }`
- `GET /sessions/:sessionId/parts` → `{ "parts": [{ "partNumber": 1, "sizeBytes": 8388608 }] }`

Use the server's committed part numbers to skip successful parts. Pause by
stopping client transfers; no backend pause state is needed. A retry may submit
the same part number again. Part numbers may be uploaded out of order.

### Upload a part

`PUT /sessions/:sessionId/parts/:partNumber`

Send raw bytes with `Content-Type: application/octet-stream` and an exact
`Content-Length`. There is no JSON wrapper and no client-supplied ETag.

```http
PUT /api/content-studio/uploads/sessions/{sessionId}/parts/1
Authorization: Bearer <access-token>
Content-Type: application/octet-stream
Content-Length: 8388608

<raw part bytes>
```

Success: `200 OK`, `{ "part": { "partNumber": 1, "sizeBytes": 8388608 } }`.

### Complete

`POST /sessions/:sessionId/complete` — empty body; no client part list.

Success: `200 OK`, `{ "session": PublicUploadSession, "asset": ... }` for a
schedule upload or `{ "session": PublicUploadSession, "media": ... }` for a
client-library upload. Repeated completion returns the same finalized record.
The returned record has the existing Content Studio media-processing fields;
processing remains asynchronous through the existing worker.

### Cancel

`DELETE /sessions/:sessionId` → `200 OK`, `{ "sessionId": "...", "state": "aborted" }`.
Only the original uploader may cancel. Completed objects are never deleted by
this endpoint or recovery cleanup.

## Current validation and limits

Supported MIME types, matching current Content Studio playback formats:

- Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`,
  `image/avif`, `image/svg+xml`.
- Video: `video/mp4`, `video/webm`, `video/quicktime`.

The 1 GiB Content Studio maximum remains in force. The default server-selected
part size is 8 MiB (configurable from 8–16 MiB). Proposed conservative initial
quotas, enforced in PostgreSQL under organization/user advisory locks:

| Limit | Default |
|---|---:|
| Active sessions per user | 2 |
| Active sessions per organization | 8 |
| Reserved bytes per user | 2 GiB |
| Reserved bytes per organization | 10 GiB |
| Concurrent parts per session | 2 |
| Concurrent parts per user | 4 |
| Concurrent parts per organization | 16 |

The rate-limit defaults are 10 session mutations per user per hour and 1,000
parts per user per minute, with a separate organization part-rate ceiling.
These defaults are configurable and should be tuned only after observing
production resource use.

## Environment variables

Only the feature flag must be set explicitly for safe rollout; the other
settings have validated defaults in `src/config/env.ts`.

| Variable | Default / meaning |
|---|---|
| `CONTENT_STUDIO_RESUMABLE_UPLOADS_ENABLED` | `true` in current env templates; blocks new sessions when false |
| `CONTENT_STUDIO_MAX_UPLOAD_BYTES` | Existing 1 GiB per-file maximum |
| `CONTENT_STUDIO_UPLOAD_PART_SIZE_BYTES` | `8388608` (8 MiB), range 8–16 MiB |
| `CONTENT_STUDIO_UPLOAD_SESSION_INACTIVITY_SECONDS` | `604800` (7 days) |
| `CONTENT_STUDIO_UPLOAD_TERMINAL_RETENTION_SECONDS` | `2592000` (30 days) |
| `CONTENT_STUDIO_UPLOAD_MAX_ACTIVE_PER_USER` | `2` |
| `CONTENT_STUDIO_UPLOAD_MAX_ACTIVE_PER_ORGANIZATION` | `8` |
| `CONTENT_STUDIO_UPLOAD_MAX_RESERVED_BYTES_PER_USER` | `2147483648` (2 GiB) |
| `CONTENT_STUDIO_UPLOAD_MAX_RESERVED_BYTES_PER_ORGANIZATION` | `10737418240` (10 GiB) |
| `CONTENT_STUDIO_UPLOAD_MAX_CONCURRENT_PARTS_PER_SESSION` | `4` |
| `CONTENT_STUDIO_UPLOAD_MAX_CONCURRENT_PARTS_PER_USER` | `8` |
| `CONTENT_STUDIO_UPLOAD_MAX_CONCURRENT_PARTS_PER_ORGANIZATION` | `16` |
| `CONTENT_STUDIO_UPLOAD_SESSION_RATE_LIMIT` | `10` per configured session-rate window |
| `CONTENT_STUDIO_UPLOAD_SESSION_RATE_WINDOW_SECONDS` | `3600` |
| `CONTENT_STUDIO_UPLOAD_PART_RATE_LIMIT` | `1000` per configured part-rate window |
| `CONTENT_STUDIO_UPLOAD_PART_RATE_WINDOW_SECONDS` | `60` |

The multipart adapter uses the existing private MinIO endpoint, access key,
secret key, region, and TLS CA settings. It does not write credentials to
PostgreSQL or return them to the client.

## Migration and deployment

Migration `0064_content_studio_resumable_uploads.sql` is additive. It creates
`content.upload_sessions` and `content.upload_session_parts`, adds unique
composite indexes on existing schedule/client target keys for organization and
office-scoped foreign keys, and adds state/ownership/expiry/part indexes and
constraints. It does not update existing media rows or MinIO objects. No
migration has been applied by this implementation task.

After the frontend is ready and deployment is separately approved:

1. Review the release diff, run `npm run build`, the targeted tests, and
   `npm run validate:vps`. Back up PostgreSQL using the established VPS
   procedure. Confirm the deployment is targeting the intended database; the
   checked-in VPS Compose stack currently uses staging-named resources.
2. Synchronize the reviewed release to `/opt/kode-platform`, preserve
   `.env.vps`, and set
   `CONTENT_STUDIO_RESUMABLE_UPLOADS_ENABLED=false` there.
3. From `/opt/kode-platform`, build the API and apply migrations from the
   release image. `npm run migrate` applies every pending numbered migration,
   not just 0064:

   ```sh
   docker compose --env-file .env.vps -f docker-compose.vps.yml build api
   docker compose --env-file .env.vps -f docker-compose.vps.yml \
     run --rm --no-deps api npm run migrate
   ```

   Inspect migration output and schema before proceeding. Do not manually edit
   the migration ledger or apply this migration to production as part of this
   task.
4. Recreate only the API, with the flag still disabled, then run the
   repository's verification procedure:

   ```sh
   docker compose --env-file .env.vps -f docker-compose.vps.yml \
     up -d --no-deps --force-recreate api
   npm run verify:vps
   ```

   Follow [the VPS deployment runbook](../deployment/vps.md) for its firewall,
   network, public health, and CORS prerequisites. Preserve the current
   30-minute API timeout. Do not restart or alter PostgreSQL, MinIO, playback
   workers, or Caddy for this feature.
5. Schedule bounded recovery and retention maintenance at five-minute
   intervals using the same release image and `.env.vps`:

   ```sh
   cd /opt/kode-platform
   docker compose --env-file .env.vps -f docker-compose.vps.yml \
     run --rm --no-deps api npm run job:content-studio:upload-maintenance
   ```

   The command recovers orphaned initiations and interrupted completions,
   expires/aborts bounded batches of incomplete sessions, preserves completed
   objects while reconciling metadata, and prunes terminal session rows after
   their configured retention. Configure the host scheduler separately; this
   implementation does not install or activate a cron job.
6. Before enabling the flag, validate real MinIO behavior and the Caddy path
   with disposable data, including part retries, cancellation, a large upload,
   recovery after API restart, and playback authorization/range behavior. Keep
   the flag disabled until those external checks and frontend readiness are
   approved.

The exact `docker compose` commands above are deployment instructions only;
they were not run. Do not execute them without release approval.

## Rollback

1. Set `CONTENT_STUDIO_RESUMABLE_UPLOADS_ENABLED=false` and recreate only the
   API. This stops new session creation while the same backend continues
   status, part upload, completion, and cancellation for authorized existing
   sessions.
2. Keep the resumable-capable API and maintenance command in service until
   active sessions are completed, cancelled, or expired and their 30-day
   terminal retention has elapsed. Do not roll back to code that removes the
   resumable routes while sessions can still be active.
3. After that drain, a code rollback may use the normal reviewed VPS image
   rollback procedure. Leave migration 0064 and its tables in place; do not
   drop tables or delete media objects as part of rollback.

## Verification status and remaining release gates

Local automated service tests exercise a generated 312 MiB upload as 39
bounded streams, retries, out-of-order parts, interruption/reconciliation,
concurrent completion, lost completion acknowledgement, metadata failure,
cross-organization/non-owner rejection, cancellation, expiry, and the disabled
feature flag. A local HTTP MinIO-protocol fixture tests streamed adapter
initiation, part upload, listing, completion, and abort.

No PostgreSQL migration has been applied or integration-tested; no real MinIO
server, deployed Caddy path, 30-minute API timeout, production playback worker,
or production media was exercised. Those are release gates. Existing upload,
playback, authorization, range, and media-processing regression tests remain
required and are run with the targeted test command below:

```sh
APP_ENV=development NODE_ENV=development HOST=127.0.0.1 \
LOG_LEVEL=silent DATABASE_HOST=127.0.0.1 DATABASE_NAME=kode_platform \
DATABASE_USER=kode DATABASE_PASSWORD=test \
AUTH_TOKEN_SECRET=dev-only-kode-platform-access-token-secret \
npx tsx --test \
  tests/content-studio-resumable.test.ts \
  tests/minio-multipart-storage.test.ts \
  tests/content-media-auth.test.ts \
  tests/content-studio-reliability.test.ts \
  tests/media-storage-stream.test.ts \
  tests/schedule-playback.test.ts \
  tests/media-control-plane.test.ts
```
