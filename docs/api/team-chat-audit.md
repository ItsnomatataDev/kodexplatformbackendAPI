# Team chat attachment and presence audit

Date: 2026-10-21

Scope: backend source in this checkout. No frontend source or live receiver network trace was available. Existing unrelated working-tree changes were preserved. This audit makes no runtime changes.

## Findings

### 1. Attachment URLs require authenticated fetching (high; confirmed contract, suspected symptom cause)

`src/routes/chat.ts` returns `/api/chat/media?bucket=...&objectKey=...` from `POST /attachments`. `src/app.ts` applies API authentication to chat media, and `src/auth/middleware.ts` accepts only an Authorization bearer header. Ordinary image elements and browser download navigation do not attach the application's bearer token. Using the returned URL directly therefore fails authentication. The URL is also relative: a separately hosted frontend must resolve it against the API origin.

A sender could see a local upload preview while the receiver fails to load the stored object; that explanation requires frontend verification. Confirm the receiver's media request URL, HTTP status, and whether Authorization is present without recording the token. A 401 supports the authentication issue; a request to the frontend origin supports an origin-resolution issue; a 403 requires checking conversation membership/object scope; a 404 requires checking the stored bucket/key and routing.

Recommended fix: authenticated fetch against the API origin, then display/download a blob URL and revoke it when finished. Alternatively implement short-lived, narrowly scoped media capabilities for native image/download requests. Do not make chat buckets public or put access tokens into attachment URLs.

### 2. Upload completion is separate from message delivery (high; confirmed contract)

`POST /attachments` only stores bytes and returns attachment metadata. It does not create or broadcast a chat message. The client must subsequently post a message with `attachmentUrl` and `attachmentName`; the message route persists and broadcasts those fields unchanged. A successful upload alone is not successful sending. Arbitrary URL values are accepted, so a client can also persist a sender-only blob URL or an attachment belonging to another conversation.

Confirm that a message POST follows upload, succeeds, and stores the returned server URL. Check the recipient's message history independently of WebSocket delivery. Recommended hardening: bind uploaded attachments to message/conversation records, validate their scope, and make the UI report send success only after message creation succeeds.

### 3. Closing any connection marks the user offline (high; confirmed defect)

`src/routes/chat-ws.ts` publishes offline unconditionally on every close. `src/chat/hub.ts` tracks connections but never checks whether the same user has another connection. Closing one tab/device therefore tells peers the user is offline while another remains connected. Fix presence with per-user active connections across all server instances; emit offline only when the final live connection expires or closes.

### 4. Reconnecting clients receive no presence snapshot (high; confirmed gap)

On connection, the WebSocket route emits only the connecting user's online event. There is no chat presence query or snapshot of existing users. A client joining after a colleague connected cannot reconstruct that colleague's current status from subsequent events alone. Add an organization-scoped snapshot and reconcile it on reconnect.

### 5. No heartbeat expiry or durable chat last-seen (high; confirmed gap)

The client `ping` handler only replies with `pong`. There is no chat heartbeat timestamp, TTL, or stale-connection sweep in the route/hub/server. Abrupt network loss can leave stale online state until a transport close is detected, with no application-defined deadline. A server crash cannot publish close events.

Presence payloads contain only user ID and status. The envelope's `at` field is event creation time, not a persisted last-seen value. Chat member responses do not expose last-seen. Authentication session timestamps exist elsewhere but are not a chat presence contract. Implement shared expiring connection records and a persisted last-seen timestamp, returning UTC timestamps and formatting them in the viewer's timezone. The frontend's message-time formatting could not be assessed here; message serialization already uses ISO timestamps.

### 6. Realtime delivery requires subscriptions and working cross-instance transport (medium; confirmed limitations)

The hub sends conversation events only to connections explicitly subscribed to that conversation. It does not automatically subscribe members or deliver an inbox event to every member. A receiver must subscribe and refetch history after reconnect to recover missed events. Redis pub/sub does not replay missed messages. If Redis is unavailable and the hub falls back to local fan-out, recipients connected to another server instance miss realtime events.

### 7. Unscoped files are readable across the organization (medium; confirmed access gap)

Uploads can omit conversationId. `assertCanReadChatMedia` skips conversation membership checks for `unscoped` keys, allowing another authorized chat reader in the organization with the key to fetch them. This does not explain blocked downloads, but should be corrected by binding uploads to a conversation or enforcing uploader ownership until attachment to a message.

## Verification and acceptance criteria

Executed `tests/chat-realtime.test.ts`: all 3 tests pass. They cover envelope shape, channel naming, and local fan-out only; they do not establish attachment delivery or presence correctness. No live database, MinIO, Redis, or browser end-to-end verification was performed.

Before closing these issues, verify:

- Two distinct users can send and retrieve an image and a document, including after refresh, with exact bytes preserved.
- A nonmember cannot fetch a conversation attachment; a member can fetch it with valid authentication.
- Upload success followed by message failure is shown as a failed send, with retry behavior.
- A user joining later receives existing users' current presence.
- Closing one of two sessions leaves the user online; closing the final session marks them offline.
- Network loss and server termination expire online status within a documented heartbeat deadline, including across server instances.
- Last-seen survives reconnect/restart and uses a documented timestamp meaning; displayed times are checked in different timezones.
- A receiver reconnecting after missed messages recovers history and refreshes presence.
