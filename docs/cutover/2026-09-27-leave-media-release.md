# Live leave recovery and Content Studio media release — 2026-09-27

Target: `/opt/kode-platform` on `128.140.124.44`, API container `kode-vps-api`.
The live cutover uses `APP_ENV=staging` and database `kode_platform_staging`
on loopback port 5433. This is the existing deployment's naming convention.

## Leave recovery

Applied only the five fixed candidates in `scripts/recover-leave-notifications.ts`
using `--apply --target=live-vps --confirm="RECOVER 5 LEAVE REQUESTS"`.
The target flag explicitly selects the reviewed VPS database; the default still
permits only the local development database. Confirmation remains mandatory.

- Five pending requests committed; total request count increased from 36 to 41.
- Zero balance changes; existing requests and profile balances verified unchanged.
- Post-deployment read-only rerun: 0 would-create, 5 would-skip, 0 blocked;
  total remains 41.
- Anesu remained excluded due to the office mismatch.
- Recovery provenance stored in request metadata; separate request-audit entries
  were not written because no established recovery-safe mechanism exists.
- No approvals, leave deductions, or identity/membership changes were made.

Created request IDs, in candidate order 1, 2, 3, 4, 6:

```
b0cc0366-1061-4820-b528-6794663f274e
6bebca4c-81fd-46b5-b79f-4f18d12600c7
6f322e1a-db80-4900-bb83-28df79081374
27242680-559e-4bba-93f6-332f64c7c6c8
4599e839-21a9-436a-a464-24106eb55af0
```

## Media deployment

Built from the approved source-only VPS snapshot, not the entire dirty local
workspace. Only these eight source files differed from the live snapshot:

- `src/app.ts`: exact mounted GET `/api/content-studio/media` bypasses Bearer
  middleware and reaches opaque-capability validation.
- `src/routes/content-studio.ts`: authenticated capability issuance and
  capability-only native media reads with ownership revalidation.
- `src/content/media-capability.ts`: opaque, server-side, expiring capabilities.
- `src/content/postgres-store.ts`: organization/object ownership lookup.
- `src/content/store.ts`: ownership lookup interface.
- `src/content/media-stream.ts`: streaming responses and correct QuickTime MIME.
- `src/files/minio-storage.ts`: canonical object-key encoding for signed requests.
- `src/files/memory-storage.ts`: range-response typing and invalid-range behavior.

No frontend, preview authentication, or portal authentication changes deployed.
No database migrations run. Only the API container was recreated.
Capabilities expire after 60 seconds and do not survive API restarts; clients
must request a fresh capability when necessary.

Rollback resources remain on the VPS:

- Image: `kode-platform-vps-api:before-media-20260927`
- Source: `/opt/kode-platform/backups/media-20260927/source.tgz`
- New image: `sha256:9bd487c44bb25ccd9e117d287f6a9cec1e5325f9ac8c735f368fe0875ad3039f`

## Media data comparison

Read-only inventory: local 1,000 media records; live 1,204. Local has 843
records with available objects, live has 1,062. For shared record IDs, every
available local object is available live; no storage-path conflicts were found.

Seventeen local-only records date from July–August. Fifteen have no local
object. Of the two with local images, one object's path is already referenced
online under another record. The remaining image is a possible restoration,
not a verified new upload. These old records were left untouched pending the
user's preference; no local database snapshot was imported and no live media
was overwritten. Existing live records with unavailable objects were not repaired
by this release.

## Verification

- `npm run build`: passed locally and in the VPS Docker build.
- Isolated release source compiled successfully.
- Focused local media/recovery tests: 17 passed.
- Media tests against the isolated release source: 8 passed, including both
  schedule and client binary upload → capability → native range-read flows.
- `git diff --check`: passed.
- Deployed application instantiated inside the live container against actual
  PostgreSQL and MinIO: valid capability returned 206 with 32 bytes; missing,
  invalid, and expired capabilities returned 403; protected API routes returned 401.
- Running HTTP server: missing/invalid capabilities returned 403; unauthenticated
  capability issuance and `/api/me` returned 401.
- Public HTTPS `/health`: 200, database check OK; native media without cap: 403.

The valid-capability runtime check used an in-process application instance in the
live container. A signed-in browser upload/playback session was not performed.
