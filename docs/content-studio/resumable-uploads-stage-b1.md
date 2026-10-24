# Content Studio resumable uploads — Stage B1 audit and design

**Status:** Stage B1 audit/design completed. B2–B5 are implemented locally in
the adjacent API/operations guide. No production database, storage objects,
credentials, workers, proxy, or services were changed or accessed. Deployment
remains a separate approval and operational gate.

## Executive design

Add a resumable uploader alongside the current Content Studio upload routes.
Keep the existing one-request binary and JSON/Base64 paths unchanged.

Use PostgreSQL as the durable session and API-facing committed-part ledger, and
private MinIO multipart uploads as the byte-storage authority. Stream each part
through the authenticated API to MinIO; do not buffer a whole media file in the
API process or expose MinIO credentials/upload IDs to the browser. Any API
process can serve the next request because session ownership, part numbers,
ETags, state, and expiry live in PostgreSQL.

The upload target remains the existing Content Studio model:

- `content.client_media` for client-library uploads.
- `content.schedule_assets` for schedule uploads.
- Schedule uploads with a client continue to create the associated library
  record and schedule asset in one database transaction.
- The existing Content Studio playback worker continues to discover video
  records. The separate Media Platform processing pipeline is not implicitly
  substituted or enqueued by this design.

Initially, use an 8 MiB server-selected part size, configurable within 8–16 MiB.
This exceeds S3's 5 MiB minimum for non-final parts, fits the current 1 GiB
Content Studio file-size ceiling with far fewer than 10,000 parts, and keeps
individual HTTP requests bounded. The 312 MiB case is approximately 39 parts.

## Existing architecture audit

| Area | Observed contract and reusable behavior |
|---|---|
| API and authorization | [content-studio.ts](../../src/routes/content-studio.ts) is mounted under the authenticated `/api` router in [app.ts](../../src/app.ts). Mutations call `authorizeContent(auth, 'content_studio.manage')`, which derives organization scope from the authenticated membership and calls `assertAuthorized`. Schedule and client targets are loaded using organization-scoped store methods; the client route also checks its office. Reuse these checks rather than accepting a client organization, office, or target ownership assertion. |
| Existing uploads | The schedule binary route is `POST /schedules/:scheduleId/assets/binary`; the client-library route is `POST /clients/:clientId/media/binary`. Both require `Content-Length`, enforce `CONTENT_STUDIO_MAX_UPLOAD_BYTES` (default 1 GiB), derive object keys on the server, and use `putObjectStream` when available. The JSON routes remain Base64-based and are bounded by the normal attachment/request limits. Keep all four routes intact. |
| Storage abstraction | [storage.ts](../../src/files/storage.ts) defines the existing `FileStorage` object operations, including optional streaming upload, HEAD, streaming GET, range support, bucket creation, and deletion. [minio-storage.ts](../../src/files/minio-storage.ts) implements those operations against private MinIO with SigV4 signing, streaming request bodies, TLS CA support, and sanitized transport errors. Existing methods should not change behavior. Add a separate multipart contract or optional multipart capability rather than weakening the existing interface. |
| MinIO signing | The current handwritten SigV4 request builder signs a path-style object URI and an empty query string. S3 multipart calls require signed subresource query parameters and request/response XML. Extending that signer is a correctness-sensitive change. The `minio` SDK is already used elsewhere for playback URL signing; Stage B2 should evaluate using its multipart support for a new adapter configured with the same private endpoint, region, credentials, and CA. Do not change the existing storage methods to introduce multipart. Confirm API compatibility with the deployed MinIO server before rollout. |
| Content metadata | [content/store.ts](../../src/content/store.ts) and [postgres-store.ts](../../src/content/postgres-store.ts) define the domain contract. `createUploadedAsset` uses one transaction: it optionally creates a `client_media` row and then creates a `schedule_assets` row. Client uploads call `createClientMedia`. Both records store the server-generated storage path, bucket, MIME type, original/stored byte sizes, asset type, and playback/compression status. This is the metadata path to reuse. |
| Object naming and bucket | [buckets.ts](../../src/content/buckets.ts) defines the private `content-review-assets` bucket and server-side key builders. Schedule keys are organization/schedule/file-ID scoped; client keys are organization/client/file-ID scoped. Generate an unpredictable file ID from the upload session and pass the resulting key to the existing metadata methods. The client never chooses a bucket or object key. |
| Failed single-request upload cleanup | [upload.ts](../../src/content/upload.ts) deletes a newly written object after metadata failure only after `findMediaOwnership` confirms it is not referenced. Its explicit lost-COMMIT-acknowledgement guard is important. Do not apply this cleanup pattern to multipart finalization: an object may already be committed, and a lost database or provider acknowledgement must trigger reconciliation, not object deletion. |
| HTTP body handling | [body-limit.ts](../../src/middleware/body-limit.ts) deliberately bypasses buffering only for enumerated binary upload paths. Other write requests are fully read into memory as text before routing. A new part route must be explicitly classified as a streaming path before it is enabled, while enforcing its own strict declared and observed part-size limits. Do not raise or disable the general request-body limit. |
| Limits and timeout | [env.ts](../../src/config/env.ts) sets a default Content Studio object limit of 1 GiB. [server.ts](../../src/server.ts) retains a 30-minute Node request timeout. Keep both existing values/semantics. The API's actual Caddy/proxy request-body and upstream timeout settings were not available in this source audit and must be checked on the deployment path before rollout. |
| Authentication/CSRF | The global API middleware authenticates requests except a narrowly scoped GET for capability-based media playback. Global CSRF and security middleware are installed in `createApp`. New upload endpoints are ordinary authenticated API routes and must not add bypasses or query-token authentication. |
| Legacy video processing | [playback-worker.ts](../../src/content/playback-worker.ts) periodically scans `content.schedule_assets` and `content.client_media` for video records. It stages source media to temporary disk, runs FFmpeg with a 30-minute timeout, and writes immutable `.playback/v1/...mp4` derivatives. It discovers media from database metadata, not an upload callback. A finalized Content Studio video record therefore remains visible to this pipeline. Preserve its source keys, asset type, and metadata semantics. |
| Schedule playback | [schedule-playback-store.ts](../../src/content/schedule-playback-store.ts), [schedule-playback-signer.ts](../../src/content/schedule-playback-signer.ts), and existing capability/streaming routes enforce organization/attachment access, use signed playback grants where appropriate, and preserve HTTP byte ranges. Multipart completion must create the same Content Studio records and must not publish an upload as playback-ready. |
| Separate Media Platform | Migrations [0058](../../migrations/0058_media_platform.sql), [0059](../../migrations/0059_media_job_leases.sql), and [0061](../../migrations/0061_media_publication_fencing.sql) define a separate asset/job/variant pipeline. [routes/media-platform.ts](../../src/routes/media-platform.ts) registers an already-owned Content Studio video and queues processing; [processing-worker.ts](../../src/media-platform/processing-worker.ts) uses leases, heartbeat/recovery, and fencing. This is not the Content Studio metadata pipeline. Do not silently register every upload twice or change current playback delivery. If adaptive HLS is required for these uploads, make that an explicitly designed integration with its own ownership and idempotency contract. |
| Existing test coverage | [content-media-auth.test.ts](../../tests/content-media-auth.test.ts) exercises both binary and JSON upload paths, storage cleanup on metadata failure, authenticated media access, and range playback. [content-studio-reliability.test.ts](../../tests/content-studio-reliability.test.ts), [media-storage-stream.test.ts](../../tests/media-storage-stream.test.ts), and [media-control-plane.test.ts](../../tests/media-control-plane.test.ts) cover adjacent behavior to preserve. These tests are a compatibility baseline, not evidence that resumable behavior already exists. |

### Audit findings that constrain implementation

1. **There is no current durable upload-session or part table, multipart storage
   interface, multipart route, or expiry/reconciliation worker.**
2. **The current single-request binary routes are already streaming-capable.**
   Replacing them would risk existing schedule, client-library, and playback
   behavior without solving a gap in their contract.
3. **Metadata persistence is not currently idempotent by upload session.**
   The current domain methods create rows; resumable finalization needs stable
   record IDs and a transaction that can safely be replayed.
4. **The current API upload type is client-supplied metadata.** The existing
   `contentAssetTypeFromMime` maps unknown types to `image`; new sessions need an
   explicit supported-type policy and must not treat a browser MIME claim as
   proof of file contents.
5. **The legacy playback worker and Media Platform worker are different
   pipelines.** The former scans Content Studio rows and emits MP4 derivatives;
   the latter requires a `media_platform.assets` row and a queued job and
   serves through its own playback-capability flow.
6. **Proxy behavior remains an external deployment prerequisite.** This audit
   cannot verify Caddy buffering, request-body limits, upstream timeouts,
   bandwidth, or the installed MinIO server version.

## Proposed API contract

All endpoints below are under `/api/content-studio`, require an authenticated
Kode bearer session, and use `content_studio.manage` for mutations. The session
record is the authority; clients never submit authoritative organization,
bucket, object key, multipart upload ID, completion ETags, or part lists.

### Create a session

`POST /api/content-studio/uploads/sessions`

Request fields:

- Exactly one target: `scheduleId` or `clientId`.
- `filename`, `mimeType`, `fileSizeBytes`.
- Schedule-only metadata such as `displaySlot`, `heading`, and `caption`, or
  client-library metadata such as `label`.
- No bucket, object key, provider upload ID, organization ID, or client-chosen
  part size.

The server resolves the organization and office from authenticated context,
validates the target through the existing `ContentStore`, checks supported
media type and the configured object-size ceiling, chooses the part size, then
creates a session and initiates private MinIO multipart storage. Return the
session ID, state, part size, expected part count, expiry, and committed part
numbers/sizes. Do not return credentials or provider multipart IDs.

### Inspect and resume

- `GET /api/content-studio/uploads/sessions/:sessionId`
- `GET /api/content-studio/uploads/sessions/:sessionId/parts`

Reauthorize every request against the current authenticated user, organization,
`content_studio.manage` permission, and the stored target. Reconcile provider
parts with the PostgreSQL part ledger before reporting authoritative progress.
Resume is client-side: load the session and parts, then submit only missing or
deliberately retried part numbers. A separate backend pause/resume operation is
not needed; pausing means the client stops sending parts, and the durable
session remains available until expiry.

### Upload one part

`PUT /api/content-studio/uploads/sessions/:sessionId/parts/:partNumber`

The body is raw bytes, streamed through the API into the recorded bucket/key and
provider multipart upload ID. Validate the session state, part-number range,
declared `Content-Length`, and actual streamed byte count against the exact
expected size for that part. Non-final parts must meet the provider's minimum
size; the final part may be smaller. The server records provider-returned ETag
and byte count only after the provider acknowledges the write. Never accept an
ETag or committed-part list from the client as completion authority.

Retries are allowed for the same part number. Serialize concurrent requests
for the same `(session, part number)` across API processes; the provider's
latest committed part and the server ledger must converge on the same version.
Out-of-order part numbers are valid.

### Complete or cancel

- `POST /api/content-studio/uploads/sessions/:sessionId/complete`
- `DELETE /api/content-studio/uploads/sessions/:sessionId`

Completion has no client-supplied part list. The server obtains provider parts,
validates a contiguous sequence, expected per-part sizes, and total bytes,
then completes and HEAD-verifies the object before committing Content Studio
metadata. Return the existing serialized media or asset record and its
processing state. Repeated completion requests return the same result.

Cancellation is allowed only before completion. It aborts the provider upload
and records cancellation; it never deletes an object once completion may have
succeeded. A completed session is not cancellable.

## Proposed durable schema

Add a numbered migration after the current highest migration
([0063_infrastructure_authentication.sql](../../migrations/0063_infrastructure_authentication.sql));
confirm the next number against the migration ledger when B2 is approved.
Keep the new tables in the `content` schema.

### `content.upload_sessions`

Proposed columns and invariants:

- `id UUID PRIMARY KEY`; unique per session.
- `organization_id UUID NOT NULL`; FK to the owning organization.
- `created_by UUID`; FK to `identity.users` with an explicitly chosen
  deletion policy.
- `target_type` constrained to `schedule_asset` or `client_media`.
- Nullable `schedule_id` / `client_id`, with a CHECK that exactly one target
  matches `target_type`; include the server-resolved `office_id` as needed for
  reauthorization.
- `bucket TEXT`, `object_key TEXT`, and provider `upload_id TEXT`; bucket and
  key are generated by the server, and no storage credentials are stored.
- `original_filename`, validated `mime_type`, `expected_size_bytes BIGINT`,
  `part_size_bytes INTEGER`, and `expected_part_count INTEGER`.
- `state` constrained to explicit states such as `initiating`, `uploading`,
  `completing`, `completed`, `aborting`, `aborted`, `expired`, and `failed`.
- A stable, pre-generated `media_record_id UUID` used to make domain metadata
  finalization repeatable.
- Creation/update/expiry/completion/cancellation timestamps; a completion
  lease/version or equivalent claim token for cross-process finalization.
- Constraints: positive bounded file size; part size within configured/provider
  limits; part count equals the ceiling of file size divided by part size;
  unique `(bucket, object_key)` and unique non-null `(bucket, upload_id)`.
- Indexes for `(organization_id, created_by, created_at)`, active-session
  expiry, and recovery by state/update time.

Use composite target foreign keys (organization plus target ID, and office
where applicable) or equivalent database constraints. If adding composite
unique indexes to existing content tables is necessary, account for them in
the migration and validate production data first. API checks remain mandatory;
database constraints are an additional tenant-isolation boundary.

### `content.upload_session_parts`

- `session_id UUID`, `part_number INTEGER`, `size_bytes BIGINT`, provider ETag,
  and `updated_at`.
- Primary key `(session_id, part_number)`; FK to the session with
  `ON DELETE CASCADE`.
- Check part number within provider range and positive byte count.
- Store only server-observed provider ETags and lengths. Do not trust a browser
  manifest or ETag.

MinIO is the byte-level authority. PostgreSQL part records provide durable
status and efficient API response, but must be reconciled with provider
`ListParts` after retries, interrupted requests, or uncertain acknowledgments.

## State, consistency, and recovery

### Session progression

`initiating → uploading → completing → completed`

Other terminal paths are `aborted`, `expired`, or `failed`. A temporary
provider/database failure should not automatically mark a still-recoverable
session failed.

### Creation and orphan initiation

1. Validate and reserve quota in PostgreSQL; persist an `initiating` session
   with its deterministic object key and expiry.
2. Initiate the provider multipart upload.
3. Persist the provider upload ID and transition to `uploading`.
4. If a process stops between steps 2 and 3, recovery must find the pending
   provider upload by the session's exact object key (or otherwise safely abort
   it) before retrying initiation. Never let an initiating session silently
   create unbounded orphan multipart uploads.

### Part acknowledgment and retries

1. Acquire a cross-process per-session/part claim or advisory lock.
2. Verify that the session is active and the requested part's exact expected
   byte count is within the session and configured limits.
3. Stream with backpressure and count bytes as they pass; abort the provider
   request on excess, truncation, disconnect, or timeout.
4. On provider success, upsert the provider ETag and part length in PostgreSQL.
5. If the database write fails after provider success, retain the provider
   part. The next status/retry operation calls `ListParts` and repairs the
   ledger. Never delete a potentially committed part or final object because
   an acknowledgment was lost.

### Completion idempotency

Use a short PostgreSQL transaction to claim completion for the session and
prevent simultaneous finalizers across API processes. Do not hold a database
transaction open while a large provider operation runs. The claimant:

1. Lists provider parts and validates the full manifest/size.
2. Completes the provider upload.
3. HEAD-verifies the final object and expected size.
4. In one PostgreSQL transaction, creates the existing schedule/client
   metadata with the stable `media_record_id` and marks the session completed.
5. On retry after uncertain provider completion, HEAD the deterministic key.
   If the expected object exists, reconcile it instead of deleting it or
   starting another upload.
6. On retry after uncertain database commit, find the metadata by its stable
   primary key and finish/return the same result. A uniqueness conflict is
   reconciled only after verifying the row belongs to this session's
   organization, target, and object key.

The finalization store method must preserve the existing transaction behavior:
for a schedule with a client, create the library media row and schedule asset
together; otherwise create just the schedule asset. For a client target, create
one library row. The session's stable record ID and a transaction-level
completion claim prevent duplicate metadata.

### Expiry and abandoned multipart cleanup

Add a bounded cleanup/reconciliation task using a PostgreSQL advisory lock or
leased work rows so only one cleanup owner handles a given session. It should:

- Expire inactive sessions based on `expires_at`; the initial proposed
  inactivity window is seven days, subject to product approval.
- Abort provider multipart uploads only for non-completed states.
- Reconcile `initiating`, `completing`, and `aborting` sessions before taking
  destructive action.
- Retain terminal session/idempotency records for a separately configured
  period (proposed 30 days) before pruning session and part rows.
- Report counts and sanitized error codes. Never log access keys, signed URLs,
  request headers, provider upload IDs, or file bytes.

Provider lifecycle cleanup can be an additional backstop only after its effect
on session expiry and recovery has been tested with the deployed MinIO version.

## Security, limits, and resource controls

- Reuse global API authentication, CSRF, `content_studio.manage`, and
  organization-scoped target lookups. Bind every session to its creator and
  organization. Each part, status, resume, completion, and cancellation request
  must re-check permission and target scope; a session UUID is not authorization.
- Restrict mutation and visibility to the session creator unless existing
  administrator/manager policy is explicitly approved to permit takeover.
  Never permit access across organizations.
- Server-generates bucket, object key, session ID, target metadata, provider
  upload ID, part size/count, and media record ID.
- Preserve the existing 1 GiB Content Studio default maximum unless product
  approval changes it. Apply the same maximum to resumable sessions and reserve
  expected bytes against an organization quota atomically to prevent parallel
  sessions from bypassing quotas.
- Use a configurable 8–16 MiB part size, with an initial 8 MiB default and
  provider-compatible minimum/maximum/count checks. Strictly validate actual
  streamed bytes in addition to `Content-Length`.
- Add bounded per-session concurrent parts, global/API concurrency controls,
  per-user and per-organization session/byte quotas, and rate limits. The
  current Content Studio route does not directly consume the limiter values
  installed in Hono context, so do not assume those limits already protect
  multipart endpoints.
- Add the new part path to the explicit streaming exceptions in
  `body-limit.ts`; keep route-specific length checks, request-size bounds,
  cancellation, and general HTTP limits. Avoid text decoding or full-body
  buffering for chunks.
- Validate filename length/encoding and supported MIME types. Treat declared
  MIME and extension as claims; use an explicit allowlist and bounded content
  signature checks where practical. Do not default arbitrary types to `image`.
- Keep storage private. No bucket policy changes or public object URLs.
- Log correlation/session identifiers only if sanitized and non-secret; never
  log raw media, authorization headers, signed URLs, provider IDs, or storage
  credentials. Emit audit events for start, part accepted/reconciled,
  completion, cancellation, expiry, and failure without file contents.
- Keep the current 30-minute Node request timeout. Confirm Caddy/proxy body,
  buffering, and timeout settings before an end-to-end large upload.

## Compatibility and playback impact

| Existing behavior | Required invariant |
|---|---|
| Single-request binary and JSON/Base64 upload | No route removal, request-shape change, bucket change, or increased general body limit. Existing tests must continue passing. |
| Content Studio ownership and tenant isolation | Resolve schedule/client from current auth organization; persist the same org/office/target fields as current upload. Reject cross-org session access before storage operations. |
| Media URLs and private storage | Save the same `/api/content-studio/media` proxy URL pattern and private bucket/object-key contract. Keep capability authorization and safe object ownership checks. |
| Playback readiness and seeking | New video rows begin with the current non-ready status. Existing legacy playback worker discovers them after metadata commit; preserve original objects and range/capability delivery. Upload completion is not playback readiness. |
| Optional Media Platform processing | Do not create duplicate assets/jobs automatically. If adaptive HLS is required, register via the existing ownership-checked API/service after Content Studio finalization, with its own idempotency and failure behavior. |
| Cleanup | Abort incomplete multipart sessions only. Never delete a completed or possibly committed object due to an API/DB acknowledgment error. Keep reference-aware cleanup for existing deletion flows. |

## Feature flag and rollout/rollback proposal

Introduce `CONTENT_STUDIO_RESUMABLE_UPLOADS_ENABLED`, default `false`, using
the existing strict boolean environment parsing pattern. When disabled, session
creation and part writes are unavailable and the frontend continues using
existing upload endpoints. Deploy the schema and storage adapter before
enabling the flag. Do not change the old route behavior.

For rollback, first disable new session creation while continuing to serve
status, part retry, completion, and cancellation for already-created sessions.
Drain or expire active sessions before disabling all resumable endpoints or
removing multipart support. Keep the additive tables until sessions and
idempotency-retention windows have elapsed. Do not roll back by deleting
objects, dropping tables with active sessions, or reverting old upload routes.

Before enabling in production:

1. Review and apply the additive numbered migration through the established
   migration process; verify the migration ledger and schema.
2. Validate actual MinIO multipart behavior and credentials with a disposable
   bucket/session, not production media.
3. Validate the real Caddy path for 8 MiB streaming requests, concurrent parts,
   cancellation, and request timeouts. The API request timeout setting alone
   does not prove proxy compatibility.
4. Enable for a restricted test cohort, monitor bounded metrics and cleanup,
   then increase rollout only after recovery and playback checks.

## Stage B2–B5 implementation and test gates

### B2 — Database and storage

- Add versioned session/part tables, constraints, and indexes.
- Add separate multipart storage operations while preserving all current
  `FileStorage` methods and their behavior.
- Test initiation, streamed part upload, provider part listing, completion,
  abort, encoded keys, TLS/signing configuration, size limits, and storage
  errors against a fake adapter plus a disposable MinIO compatibility fixture.

### B3 — API and metadata finalization

- Add session/create/status/parts/part/complete/cancel routes.
- Add session repository/service and a transaction-safe idempotent metadata
  finalizer for both schedule and client targets.
- Add explicit streaming-body routing and route-level byte limits.
- Test auth, permissions, organization/office boundaries, current-target
  validation, and unchanged legacy upload/playback routes.

### B4 — Reliability and operations

- Add provider/PostgreSQL reconciliation, expired-session cleanup, orphan
  initiation recovery, part retry serialization, concurrency/quota control,
  structured audit events, and bounded operational metrics.
- Verify duplicate and simultaneous requests across independent API instances.

### B5 — Compatibility validation

- Exercise the full matrix below without touching production media.
- Verify playback capability and HTTP ranges on completed Content Studio
  records; verify video processing status independently from upload status.
- Prepare and review rollout, proxy validation, monitoring, and rollback before
  enabling the feature flag.

| Required scenario | Stage/test approach |
|---|---|
| Successful 312 MiB upload | Fake/isolated multipart provider with generated bounded streams; assert exact bytes, all part records, one metadata result, and no whole-file buffering. Follow with a disposable MinIO integration run. |
| Part/file-size validation | Unit and route tests for zero, over-limit, wrong declared length, truncated/oversized body, invalid part count, and too-small non-final part. |
| Interrupted upload and recovery | Commit selected provider parts, restart service/repository instance, query and reconcile parts, then upload only missing parts. |
| Duplicate part retry | Repeat identical part; assert one logical part row and provider/DB ETag convergence. Retry with changed bytes and verify serialized last accepted write. |
| Out-of-order parts | Upload valid nonsequential parts; completion must use provider part ordering and reject gaps. |
| Concurrent completion | Two API/service instances race; exactly one metadata transaction/result, with the other receiving or reconciling the same completed result. |
| Lost provider completion acknowledgment | Complete provider object but throw before client acknowledgment; retry HEAD-reconciles the final object and does not delete/re-upload committed data. |
| Database failure during finalization | Fail before commit and after uncertain commit; verify no duplicate metadata, no deletion of the object, and repeatable reconciliation. |
| Cross-organization access | User from another organization cannot inspect, upload parts to, complete, or cancel the session; no storage call occurs after rejection. |
| Unauthorized cancellation | Non-owner without approved elevated policy cannot abort an active session. |
| Expiry/abandoned cleanup | Expire a session in an isolated fixture; verify abort, terminal state, repeat-safe cleanup, and no deletion of completed objects. |
| Existing binary upload compatibility | Existing schedule/client binary and JSON tests pass unchanged; retain cleanup semantics for these single-request routes. |
| Playback authorization/ranges | Existing capability, ownership, byte-range, seek, and playback-readiness tests pass; test a finalized resumable record through the same path. |
| Media processing integration | Verify legacy worker sees uploaded video metadata and processing remains separate from upload completion. Test Media Platform registration only if that optional integration is approved. |

## Decisions required before B2

The source audit does not decide product policy. Confirm these before
implementation:

1. Maximum session inactivity/resume window and terminal-record retention (the
   seven-day / 30-day values above are proposals).
2. Allowed media MIME types and whether upload content signatures must be
   verified before metadata finalization.
3. Per-user/per-organization active-session and reserved-byte quotas.
4. Whether only the creator may resume/cancel, or a Content Studio
   administrator may take over another creator's session.
5. Whether Content Studio video uploads should also be registered in the
   separate Media Platform adaptive-HLS pipeline.
6. The actual VPS MinIO version and Caddy request-body/buffering/timeout
   configuration.
