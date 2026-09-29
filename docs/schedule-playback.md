# Stateless schedule playback

`GET /api/schedules/:scheduleId/playback?currentAssetId=<finished UUID>`

The route is mounted under the existing API authentication middleware and requires
`content_studio.read`. Organization membership comes from verified authentication,
never request parameters. The database query checks ownership and asset membership
in the same PostgreSQL statement/snapshot. Cross-organization schedules and foreign
finished IDs return 404. Invalid or repeated UUID parameters return 400.

Without a finished ID, the response contains the first two eligible assets. With
one, it contains the next two eligible assets strictly after that asset's tuple
`(display_slot, sort_order, created_at, id)`. A deselected/expired finished asset
can still anchor the timeline; deleted or foreign anchors return 404. Eligible
successors are selected images/videos with a nonblank object key and no elapsed
expiry. Missing successors are JSON null, and both top-level keys always exist.
Images include `duration: 7` (seconds); videos omit it.

No playback cursor is stored or mutated. Retries select the same positions for an
unchanged timeline and eligibility. Edits/deletion/expiration can change the result;
presigned URL signatures may also differ with signing time. This contract does not
promise byte-identical URLs or a historical snapshot across requests.

The frontend must send the finished asset ID once per advancement. It must not
perform the extra successor promotion described in the earlier example for the old
contract: that would skip assets with this endpoint.

## Deployment

- Set `CORS_ALLOWED_ORIGINS` to the exact frontend HTTPS origin (comma-separated if
  multiple approved applications use this API). Existing middleware sends that
  origin and `Access-Control-Allow-Credentials: true`; it does not use `*`.
- Set `MINIO_PUBLIC_ENDPOINT` to the browser-reachable HTTPS **S3 API origin**, with
  no path, query, or credentials. It falls back to `MINIO_ENDPOINT` if omitted.
  Do not use the MinIO console URL or rewrite the hostname after signing.
- Existing `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and optional
  `MINIO_TLS_CA_FILE` configure credentials and trust. `MINIO_REGION` defaults to
  `us-east-1`. Give the signing identity GetObject access to the media buckets.
- Apply migration `0056_content_schedule_playback_index.sql` with the existing
  migration runner. This adds a full ordering index; it does not change data.
- Configure MinIO/proxy CORS separately for browser GET requests. API CORS does
  not configure storage CORS.

GET URLs last six hours. The MinIO SDK signs
`response-cache-control=public, max-age=31536000` and the asset MIME type when known.
Unknown MIME types preserve object metadata. No transcoding is performed here;
correct Content-Type does not make an unsupported codec playable.
The JSON response itself uses `Cache-Control: no-store`.

Use immutable object keys for year-long caching. `public` permits shared caching;
URL expiration does not evict downloaded copies. These are the requested cache
semantics, including for authenticated media.

## Tests

`npm test` includes route/security/CORS/concurrent signing and real SDK tests.
For the PostgreSQL integration test, set `PLAYBACK_TEST_DATABASE_URL` to a disposable
PostgreSQL database and run `npm test`. The test creates a minimal `content` schema
inside a transaction and always rolls it back; it intentionally refuses to reuse
an existing schema. No production database is needed.

Coverage includes initial playback, advancement, 110 stateless retries, all four
ordering keys, final and empty states, foreign schedules/assets, deselection,
expiration, UUID validation, missing authentication, exact credentialed CORS,
parallel signing, six-hour expiry, cache/MIME overrides, and special object keys.
