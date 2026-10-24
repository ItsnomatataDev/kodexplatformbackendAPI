# Team chat delivery and presence

Implemented in `kode-platform` and the sibling `ITsNomatataWorkSpace` web frontend, 2026-10-21.

## Attachment delivery

The web frontend downloads Kode attachments with `api.blob`, which resolves the configured API origin, supplies Authorization, and refreshes expired credentials. Images, audio, document downloads, and the full-size image preview consume blobs. The existing bounded media cache owns cached object URLs; uncached component URLs are revoked on cleanup. Access tokens are no longer placed in attachment URLs.

Uploads now require a conversation. Sending a stored Kode attachment validates the object exists and belongs to that organization and conversation, and persists a canonical relative URL without credentials. Local blob/data/file references cannot be sent. HTTPS external media (such as GIFs) remains supported.

Upload success is separate from message success. The sender shows sent only when message creation succeeds. A failed message POST retains the original file and preview for retry. Reconnecting now refreshes message history on every subscription recovery.

Legacy `unscoped` objects can be read only if a nondeleted, unexpired message containing their canonical query-style or path-style URL belongs to a conversation the reader has joined. Unlinked legacy objects are denied. Old absolute/signed legacy references may require a controlled data repair or resend; this change does not migrate historical storage.

## Presence protocol

Each browser connection has its own Redis sorted-set lease, scoped by application environment, organization and user. Updates atomically prune expired leases, touch/remove one connection, and count the remaining connections. A user stays online while any lease is live, including connections on another API instance.

- Client sends `ping` every 25 seconds. Server renews the connection lease and sends `pong`.
- Leases expire after 75 seconds without a heartbeat. A server watchdog closes idle sockets, and surviving clients refresh their watched presence on each heartbeat. Unclean disconnects can therefore take up to about 100 seconds to appear offline to a peer (lease plus snapshot interval).
- Client sends `{ "type": "presence.subscribe", "payload": { "userIds": ["uuid"] } }`, maximum 200 unique watched users. The server returns `presence.snapshot` with `payload.users`. Only active members of the authenticated organization are returned.
- `presence` events and snapshot rows contain `userId`, `status` (`online`, `offline`, `unknown`), and `lastSeenAt` (ISO UTC or null).
- `presence.ready` advertises `heartbeatMs` and `ttlMs`.
- Last-seen records the latest observed heartbeat/connect activity in PostgreSQL. Timeout cleanup does not invent a new activity timestamp. UI formatting uses the viewer's local timezone.
- A missing pong or unavailable Redis/database produces unknown status / “Status unavailable”, not a guessed offline value. Reconnect refreshes credentials, subscriptions, presence and message history.

The web chat watches up to 200 loaded conversation participants. Presence represents an active chat connection, not general website activity. Background browser timer throttling can expire a connection; it reconnects and reconciles state when execution resumes. Redis is required for authoritative presence; local-only realtime fan-out cannot establish cross-server online status.

## Rollout

1. Apply migration `0065_chat_presence.sql` through the normal migration process before deploying the backend. It adds `chat.user_presence` only.
2. Deploy the backend with Redis available to all API instances and synchronized server clocks.
3. Deploy the web frontend from `ITsNomatataWorkSpace`. Backend-only deployment does not replace the old frontend presence stub or attachment URL construction.
4. Verify two accounts can send/download an image and document; refresh the receiver; open two sender tabs and close one, then the other; disconnect the network and reconnect.

No production deployment or application database migration was performed during implementation. Integration tests used disposable local Redis and PostgreSQL containers.

## Verification

- Backend: `npm run typecheck` passes.
- Backend chat and authentication suites: 24 tests pass, including actual Redis Lua lease behavior and PostgreSQL timestamp persistence.
- Frontend: `npm run test:chat` runs 9 passing behavioral tests (authenticated blob resolution, snapshots/events, reconnect, heartbeat timeout, explicit offline state, send-success/failure cleanup, subscription acknowledgement before history recovery, presence preservation through member refreshes, and clearing the image failure timer after loading).
- Normal frontend `tsc -b` is blocked by pre-existing TS1294 at `src/features/content-review/uploads/resumableUploadManager.ts:318`. Checking with `tsc -p tsconfig.app.json --erasableSyntaxOnly false` passes; the unrelated file and compiler configuration were not changed.
- No live two-account browser/MinIO verification was performed.

The presence integration test is enabled with `CHAT_TEST_POSTGRES_URL` and `CHAT_TEST_REDIS_URL` pointing to disposable databases. Without both, that test skips. It creates a minimal schema for isolated testing and must not target an application database. Attachment tests use in-memory storage and exercise the actual upload/message/media routes.
