# IT's No Matata — Backend Health, Architecture, and Production Readiness

**Stage:** BH-1, read-only  
**Audit window:** 28 October 2026, approximately 08:40–09:05 UTC  
**Source reviewed:** repository checkout `fix/private-media-cdn-readiness` (working tree includes uncommitted chat, call, and push work)  
**Runtime reviewed:** public API host `ubuntu-8gb-fsn1-2` (`api.tmctechsolutions.com`, `meet.itsnomatata.com` → `128.140.124.44`)  
**Method:** source inspection, host process and cgroup reads, PostgreSQL catalog and statistics views, Redis `INFO`/`CONFIG GET`, one-shot external connectivity checks, and `GET /health/live` plus `GET /health/ready`. No containers, schemas, firewall rules, or data were changed.

Two other SSH hosts were opened only far enough to exclude them. `shearwater-vps` is a different application (1 vCPU, 2 GB). `control-os-media` is a 1 vCPU / 2 GB host and was not the machine described in the brief. Findings below are for the 4 vCPU / 8 GB host unless a sentence says otherwise.

The audit account can read processes, `/proc`, and PostgreSQL on `127.0.0.1:5433`. It cannot read the Docker socket, kernel logs, or `/var/lib/docker`. Docker-reported health, restart counts, image IDs, and volume byte sizes are therefore marked unavailable rather than inferred.

---

## A. Executive assessment

The API, PostgreSQL, Redis, MinIO, Caddy, LiveKit, and the media workers were all running during this window. The database is small, fully cached, and not locked. Host CPU and memory pressure were low. A request to the API on the host itself completed in about 1.5 ms. The same health URL from the auditor’s network took about 0.6–0.9 s, so that external delay is network and TLS time, not application work.

The platform is operationally up. It is not yet operationally recoverable.

**Strengths**

- One Hono process on Node 22 serves HTTP and chat WebSockets, with PostgreSQL as the system of record and Redis limited to rate limits, chat fan-out, presence, and short-lived media grants.
- Organization checks are anchored to the authenticated membership. Chat subscriptions check conversation membership before a socket joins a room.
- Chat inbox rows already include the latest message preview and an unread count in one SQL statement.
- Chat attachments stay on dedicated buckets and an authorized API stream. That path is separate from Content Studio and from the media-edge CDN.
- PostgreSQL 17.11 reported a 100.00% buffer-cache hit ratio, 0 deadlocks, 0 temp files, and 0 idle-in-transaction sessions at measurement.
- Direct TCP to API port 3000, PostgreSQL, Redis, MinIO, and the media-edge port timed out from this network. TLS on 443 and LiveKit’s published media ports are the public doors.
- Container cgroup `oom_kill` counters were 0. Memory PSI was flat. No swap is configured, and none was in use.

**Confirmed problems**

- The last backup artifact on this host is from **2026-09-22 02:00 UTC**, 36 days before the audit. It lives on the same disk as the live data. No systemd timer or `/etc/cron.d` job currently runs an application backup. A loss of this VPS takes the live data and the only observed copy with it.
- Redis has `maxmemory 0` and `maxmemory-policy noeviction`. The API, the serving PostgreSQL, Redis, MinIO, Caddy, and LiveKit have **no memory cap**. Workers that transcode do have caps. On an 8 GB host with no swap, an uncapped process is the OOM killer’s problem.
- The legacy Content Studio playback worker (up 29 days, cap 1.5 CPU / 1.5 GiB) has been CPU-throttled on 38.6% of its accounting periods and has touched a 1.12 GiB memory peak. That is the only workload in this audit with measured saturation.
- WebSocket authentication accepts the access token in the query string (`src/routes/chat-ws.ts`). Application request logs record `c.req.path`, which is the path without the query. Whether Caddy records the full URI could not be verified, because the live Caddyfile is inside a container this account cannot read.
- The public API reports `"environment": "staging"` and the database name is `kode_platform_staging`. Production-only guards (mandatory database TLS, placeholder-secret rejection) are not the guards in force on the public host.

**Important uncertainties**

- Endpoint latency, error rate, and who calls which route are not retained. There is no metrics database.
- Docker restart counts, healthcheck status, image identity, and volume sizes were not readable.
- Kernel OOM history for the last seven days was not readable. Per-cgroup `oom_kill` is 0 since each cgroup was created.
- UDP 3478 and the LiveKit UDP range 50000–60000 were not tested from outside. Concurrent calls were not in progress (2 host connections on port 7880, 0 on 7881 at the snapshot).
- `GET /api/<anything>` without a token returns 401, including a nonsense path. That response does **not** prove the running image contains the uncommitted calls or push routes. Schema migrations applied in the live database stop at `0065_chat_presence.sql`. Files `0067` and `0068` are on the server checkout and are not recorded in `platform.schema_migrations`. `0066` is not on that checkout.

**Immediate risk**

The immediate risk is recovery, not current capacity. The service can keep serving today’s load. It cannot be rebuilt from a current backup if the disk or the VPS is lost.

**VPS size**

For the measured workload — about 45 active memberships, a 53 MB database, an API resident set around 260 MiB, and load averages near 0.2 — the 4 vCPU / 8 GB host has substantial headroom. A RAM upgrade is not supported by memory pressure. The workload that has already hit a ceiling is video transcoding, and that ceiling is the worker’s 1.5 CPU quota.

---

## B. Infrastructure inventory

Public names on this host:

| Name | Resolves to | Role confirmed this window |
|---|---|---|
| `api.tmctechsolutions.com` | `128.140.124.44` | HTTPS 200 from `/health/live` and `/health/ready`, environment `staging` |
| `meet.itsnomatata.com` | `128.140.124.44` | HTTPS 200 body `OK` (LiveKit). Host config says Caddy proxies TLS to port 7880 |
| `codex.itsnomatata.com` | Vercel addresses, not this VPS | Browser origin allowed by `CORS_ALLOWED_ORIGINS` |
| `app.itsnomatata.com` | No A record from this resolver | Also listed in `CORS_ALLOWED_ORIGINS` |

Host at `/proc/meminfo` and `df`:

| Resource | Measurement |
|---|---|
| CPU | 4 vCPU, AMD EPYC-Genoa, 1 thread per core |
| RAM | 7.56 GiB total, 5.68 GiB available |
| Swap | None configured |
| Disk `/` | 150 GB ext4, 56 GB used, 89 GB available, 39%, inodes 9% used |
| Uptime | 63 days |
| Load | 0.22 / 0.32 / 0.47 |
| PSI CPU (some) | avg10 1.12%, avg60 0.94%, avg300 1.06%; full 0 |
| PSI memory | avg10/60/300 all 0.00 |
| PSI I/O | avg10/60/300 all 0.00 |

Readable disk consumers: `/var/log/journal` 2.1 GB, `/var/backups/itsnomatata` 7.1 GB (7.0 GB of that is MinIO hardlink snapshots, 82 MB is compressed archives). `/var/lib/docker` is mode `drwx--x---` and its size was not measurable. The gap between 56 GB used and the directories this account can sum is the Docker data root. PostgreSQL’s logical size is 53 MB, so the database heap is not the disk consumer.

### Process inventory mapped to cgroups

Docker names and restart counts were unavailable. Identity is the process command line plus the cgroup scope. “Up” is process elapsed time, which resets when the process is recreated.

| Service | Running | Health check | CPU | RAM now / peak | Restarts | Resource limits | Concern |
|---|---|---|---|---|---|---|---|
| API `node dist/server.js` | Yes, 21 h | Public `/health/live` and `/health/ready` HTTP 200. Docker health status unavailable. Dockerfile checks `/health/live` | Unlimited. cgroup throttle counters 0. Host snapshot ~0.7% | 258 MiB / 282 MiB | Unavailable | No memory or CPU cap. `network_mode: host`, `restart: unless-stopped` in `docker-compose.vps.yml` | Uncapped on a no-swap host. Bind is `0.0.0.0:3000`; external TCP to 3000 timed out |
| PostgreSQL 17.11 serving `kode_platform_staging` | Yes, 33 d | `pg_isready` defined in compose. Docker status unavailable. App readiness check passed | Unlimited, throttle 0 | cgroup 167 MiB / 204 MiB. `shared_buffers` 128 MB | Unavailable | No cap. Listens `127.0.0.1:5433` only. External TCP timed out | Healthy at this size. Server `statement_timeout` is 0; the app pool sets 30 s |
| PostgreSQL extra A | Yes, 19 d, no client sessions seen | Unknown | Cap 1.0 CPU. 6 throttled periods | 62 MiB / 182 MiB | Unavailable | Memory cap 768 MiB | Second postmaster, not published on the host. Purpose not named (restore or rehearsal). Still holds disk and RAM |
| PostgreSQL extra B | Yes, 19 d, no client sessions seen | Unknown | Cap 0.5 CPU. 69 throttled periods | 60 MiB / 173 MiB | Unavailable | Memory cap 512 MiB | Same as extra A |
| Redis 8 | Yes, 21 h | Compose ping check defined. Docker status unavailable | Unlimited, throttle 0 | cgroup 19 MiB / 24 MiB. `used_memory` 1.84 MB, peak 1.84 MB since this process start | Unavailable | No cap. `maxmemory 0`, policy `noeviction`. `127.0.0.1:6379`. AOF on, last write ok | Tiny today. Noeviction plus no cap means growth ends in host memory pressure |
| MinIO | Yes, 21 h | Compose `mc ready` defined. Docker status unavailable | Unlimited, throttle 0 | 649 MiB / 665 MiB | Unavailable | No cap. `127.0.0.1:9000` and `:9001`. External TCP timed out | Largest resident set on the host. Object-byte total not readable |
| Caddy | Yes, 62 d | None observed | Unlimited, throttle 0 | 76 MiB / 257 MiB | Unavailable | No cap. Public `0.0.0.0:80` and `:443` (TCP and UDP 443) | Live Caddyfile not readable. Example file in git must not be assumed to be live |
| LiveKit `v1.12.0` (`/opt/livekit`) | Yes, 62 d | `https://meet.itsnomatata.com/` returned `OK` | Unlimited, throttle 0 | 86 MiB / 114 MiB | Unavailable | No cap. Host network. Config: TCP 7881, UDP 50000–60000, TURN UDP 3478, TURN TLS 5349 | Signaling port 7880 timed out externally. 7881 and 5349 accepted TCP. UDP range not tested. Idle at snapshot |
| Media edge nginx | Yes, 6 d | nginx `/health` exists in repo config. Docker status unavailable | Cap 0.5 CPU, 0 throttled periods | 3.4 MiB / 4.8 MiB | Unavailable | 256 MiB, 0.5 CPU. `127.0.0.1:3100`. External TCP timed out | Matches `docker-compose.vps.yml` media profile |
| Media auth `playback/auth-server.js` | Yes, 2 d | Dockerfile `HEALTHCHECK NONE` | Cap 0.25 CPU, 39 throttled periods | 39 MiB / 53 MiB | Unavailable | 128 MiB, 0.25 CPU | Matches compose. Readiness is not part of `/health/ready` |
| Content Studio playback worker | Yes, 29 d | Dockerfile `HEALTHCHECK NONE` | Cap 1.5 CPU. **42,925 / 111,069 periods throttled (38.6%), 4,852 s throttled** | 119 MiB / **1.12 GiB** | Unavailable | 1.5 GiB, 1.5 CPU, 4 GiB tmpfs in compose | Only measured CPU saturation. Legacy `.playback/v1` pipeline, separate from chat |
| Media-platform worker | Yes, 6 d | Dockerfile `HEALTHCHECK NONE` | Cap 1.5 CPU. 3,299 / 510,456 periods throttled (0.6%), 617 s throttled | 57 MiB / 589 MiB | Unavailable | 1.5 GiB, 1.5 CPU | Active, within cap. Thumbnail job type is rejected in source |
| Upload maintenance | Yes, 6 d | Dockerfile `HEALTHCHECK NONE` | Unlimited, throttle 0 | 47 MiB / 48 MiB | Unavailable | No cap. Interval 300 s in compose | Expected maintenance loop, low footprint |

API, Redis, and MinIO process start times cluster at ~21 hours. PostgreSQL, Caddy, and LiveKit have been up for weeks. That is a partial recreate of the data-plane and API, not a host reboot (host uptime 63 days). Restart *counts* are still unavailable, so this does not say whether those processes had crashed before the recreate.

### Listening ports that matter

| Port | Bind seen with `ss` | From the auditor’s network |
|---|---|---|
| 22, 80, 443 | `0.0.0.0` and IPv6 | TCP open |
| 3000 API | `0.0.0.0` | TCP timeout (filtered) |
| 3100 media edge, 5433 Postgres, 6379 Redis, 9000/9001 MinIO, 7880 LiveKit HTTP | loopback, except 7880 which is `*` | TCP timeout |
| 7881 LiveKit RTC TCP | `*` | TCP open in 0.26 s |
| 5349 TURN TLS | `*` | TCP open in 0.29 s |
| 3478 UDP TURN | `*` | TCP 3478 timed out. UDP reachability not tested |
| UDP 50000–60000 | Configured in `/opt/livekit/livekit.yaml`. Not enumerated with `ss` | Not tested |

IPv6 reachability of port 3000 was not tested. `ss` showed port 3000 on IPv4 only.

---

## C. Backend architecture

```text
Web (codex.itsnomatata.com on Vercel)
Android / iOS
        │  HTTPS
        ▼
Caddy on this VPS  :443
        │  loopback HTTP
        ▼
Node 22  node dist/server.js   :3000   (Hono, src/server.ts → src/app.ts)
        │
        ├── PostgreSQL 17  127.0.0.1:5433   kode_platform_staging
        ├── Redis 8        127.0.0.1:6379   rate limit, chat pub/sub, presence, media grants
        ├── MinIO          127.0.0.1:9000   chat buckets, content-review-assets, kode-staging
        │
        ├── /ws/chat WebSocket (same process, same port)
        │
        └── workers, separate containers, same codebase
              ├── content/playback-worker.js          legacy Content Studio MP4
              ├── media-platform/processing-worker.js CDN renditions
              ├── content/resumable/run-maintenance.js
              └── media-platform/playback/auth-server.js
                        ▲
media edge nginx :3100 ─┘  auth_request, then MinIO
                        ▲
Caddy (media hostname; live site block not read)

Calls / meetings
        │  POST /api/meetings/:id/livekit-token
        │  POST /api/calls/:id/livekit-token     (source; deployment of this route not proven)
        ▼
LiveKit v1.12.0  wss://meet.itsnomatata.com
        UDP/TCP media direct to this host
```

### Entry points

| Process | Source | Command |
|---|---|---|
| HTTP API | `src/server.ts`, `src/app.ts` | `node dist/server.js` (`Dockerfile` final stage) |
| Dev | `package.json` `dev` | `tsx watch src/server.ts` |
| Playback worker | `src/content/playback-worker.ts` | `node dist/content/playback-worker.js` |
| Media-platform worker | `src/media-platform/processing-worker.ts` | `node dist/media-platform/processing-worker.js` |
| Upload maintenance | `src/content/resumable/run-maintenance.js` | 300 s loop |
| Media auth | `src/media-platform/playback/auth-server.ts` | port 3200, bridge network `media-private` |
| Infrastructure control center | `src/infrastructure/server.ts` | Separate opt-in target. No matching process was seen on this host |
| LiveKit | `/opt/livekit/docker-compose.yml` | `livekit/livekit-server:v1.12.0`, host network, not built from this repo |

Framework is Hono 4 on `@hono/node-server`. `express` is a dependency; no `express` import was found under `src/`.

### Middleware order

From `src/app.ts` (global, in this order):

1. `securityHeadersMiddleware` — CSP `default-src 'none'`, HSTS outside development. Skipped for WebSocket upgrades.
2. `corsMiddleware` — allowlist from `CORS_ALLOWED_ORIGINS`. Skipped for WebSocket upgrades.
3. `requestContext` — request id, Pino access line with method, path, status, `durationMs`.
4. `clientIpMiddleware`
5. `bodyLimitMiddleware` — buffers JSON bodies; Content Studio binary routes are excluded so uploads can stream.
6. `csrfMiddleware`
7. Inject rate limiter and limits onto the context.
8. `app.onError(errorHandler)` — 500s return a generic message and `requestId`. `AppError` messages are returned as written.

`/api/*` then runs `createAuthMiddleware` (`src/auth/middleware.ts`): verify JWT, require the session row, load auth context, reject `x-user-id` override. One exception in source: `GET /api/content-studio/media` uses a capability token instead of the session JWT.

There is no global API rate limit. Login, refresh, signup, and work-board mutations use a Redis limiter (in-memory only when `APP_ENV=development`). If Redis is down, that limiter fails closed with `RATE_LIMIT_UNAVAILABLE`.

### Authentication

- Access token: JWT (HS256, `jose`) carrying a session id. `src/auth/access-token.ts`.
- Refresh token: opaque, stored in PostgreSQL `identity.refresh_tokens`, not Redis.
- HTTP API: `Authorization: Bearer` only.
- WebSocket: query `access_token` or `token`, otherwise Bearer. `src/routes/chat-ws.ts` lines 21–27.
- Authorization: `src/authorization/authorize.ts` requires the resource organization to match the membership organization, then a permission. Domain routes add staff gates (documents, leave, attendance reports, organization administration).
- A user with more than one active membership is rejected (`MULTIPLE_ACTIVE_MEMBERSHIPS`).

### Dependency map

| Service | Purpose | Who depends on it | Failure effect evidenced in source |
|---|---|---|---|
| Caddy | TLS and public HTTP | Browsers, mobile apps, LiveKit signaling | Not in the app repo. Live file unread |
| API | All product HTTP and chat sockets | All clients | Process exit drops HTTP and WebSockets together. They share one event loop (`src/server.ts`) |
| PostgreSQL | System of record | API, all workers | `/health/ready` goes 503. Rate-limit and chat code are not a substitute |
| Redis | Rate limit, chat fan-out, presence, media capability and playback grants | API, media-auth | Rate limit and playback grants fail closed. Chat fan-out falls back to in-process delivery (`src/chat/hub.ts`). Presence reports `unknown` |
| MinIO | Objects | API, both media workers, upload maintenance | Uploads and downloads fail. Metadata in PostgreSQL remains |
| LiveKit | Real-time media for meetings and calls | Token routes in `src/meetings/livekit.ts`, `src/routes/meetings.ts`, `src/routes/calls.ts` | Token route fails if LiveKit env is missing. No LiveKit room-delete call exists in this repo. Rooms are an external concern |
| Playback worker | Legacy Content Studio MP4 under `.playback/v1/` | Content Studio playback preference | Advisory lock so one scanner runs. Chat does not use this worker |
| Media-platform worker | `.media/v2` renditions and HLS | Media edge | Postgres job lease, 3 attempts, 30 min job timeout. One job at a time in the process |
| Media edge + media auth | Signed CDN reads | Content Studio / media platform clients | Chat downloads do not go through this path |

`docker-compose.yml` is local Postgres, Redis, and MinIO only. `docker-compose.vps.yml` is the VPS stack and labels itself staging (`APP_ENV: staging`) even though this host is the public API. `docker-compose.production.example.yml` and `deploy/Caddyfile.example` are examples. `docs/deployment/vps.md` says not to replace the live Caddyfile with the example.

---

## D. API health

Local samples on the host, 28 October 2026 ~08:50 UTC:

| URL | Result | Time to first byte |
|---|---|---|
| `http://127.0.0.1:3000/health/live` | 200 | 1.0 ms |
| `http://127.0.0.1:3000/health/ready` | 200, database ok | 1.4 ms |
| `https://api.tmctechsolutions.com/health/live` from the auditor network | 200, `"environment":"staging"` | 0.87 s (single sample, includes DNS and TLS) |
| `https://api.tmctechsolutions.com/health/ready` from the auditor network | 200 | 0.65 s (single sample) |

No histogram, error rate, or per-route timing exists. Pino logs `durationMs` per request (`src/middleware/request-context.ts`) inside the API container. Those logs were not readable from this account. Treat every latency number below as either this health sample or a code fact, not an SLO.

### Route groups clients actually have

All of these sit under `/api` except `/auth` and `/ws/chat`. Handlers require a Bearer token unless noted. Payroll is payslip batches under documents, not a `/payroll` module. There is no single `/api/dashboard` aggregator. The closest reads are `GET /api/me`, `GET /api/obligations/dashboard`, and public branding.

| Area | Method and path | Handler | Data dependencies |
|---|---|---|---|
| Session | `POST /auth/login`, `/refresh`, `/logout` | `src/auth/routes.ts` | `identity.sessions`, refresh tokens, Redis rate limit |
| Shell | `GET /api/me` | `src/routes/me.ts` | Profile, optional avatar object |
| Work | `GET/POST /api/boards`, cards, `GET/POST /api/cards/:id/time-entries`, `GET /api/time-entries` | `src/routes/boards.ts`, `cards.ts`, `card-ecosystem.ts` | `work.*` |
| Attendance | `GET /api/attendance/today`, `POST /clock-in` | `src/routes/attendance.ts` | `attendance.*`. `/today` uses `Promise.all` |
| Chat | `GET /api/chat/conversations`, messages, `GET /api/chat/media/...` | `src/routes/chat.ts` | `chat.*`, MinIO chat buckets |
| Chat socket | `GET /ws/chat` upgrade | `src/routes/chat-ws.ts` | JWT, session row, Redis presence, in-process hub |
| Notifications | `GET /api/notifications`, `/unread-count` | `src/routes/notifications.ts` | `notifications.*`. Push store exists in the working tree |
| Leave | `/api/leave` | `src/routes/leave.ts` | `leave.*` |
| Documents / payslips | `/api/documents`, `/payslip-batches` | `src/routes/documents.ts` | `documents.*`, MinIO |
| Content Studio | `/api/content-studio` | `src/routes/content-studio.ts` | `content.*`, bucket `content-review-assets` |
| Playback schedules | `GET /api/schedules/:id/playback` | `src/routes/schedule-playback.ts` | Schedule store |
| Meetings / calls | `/api/meetings`, `/api/calls` in source | `src/routes/meetings.ts`, `src/routes/calls.ts` | `meetings.meetings`, LiveKit JWT |

### Answers to the ten API questions

1. **Repeated queries.** Every authenticated request runs `getSession` and then `resolveAuthContext` (`src/auth/middleware.ts`). That is two round trips before the handler. At today’s cache hit ratio this is cheap. It is still the hottest structural pattern in the API. Conversation list adds per-row unread and last-message subqueries inside one statement (`src/chat/postgres-store.ts` around lines 181–234), which is one round trip, not an HTTP N+1.
2. **Payload size.** Conversation list returns preview fields, not the member roster and not the sender’s display name. A client that only needs the inbox can stop at `GET /api/chat/conversations`. A client that needs names or members still has a reason to call `GET /api/chat/conversations/:id`. Payslip delivery reads each PDF in the request loop (`src/routes/documents.ts`).
3. **Sequential work.** Payslip `deliver` and document recipient notification walk items one by one. Attendance clock-in sequences geofence, insert, and daily status because later steps use earlier results.
4. **Recomputing stable data.** Auth context is rebuilt on every call. No short-lived cache of `(session, user)` was found. Card and time-entry totals are read from PostgreSQL, which is appropriate at 53 MB.
5. **Blocking work on the request path.** JSON bodies are buffered in memory up to the configured cap. Payslip delivery pulls objects from MinIO inside the HTTP request. Video transcoding is in other containers. The API process itself is not running ffmpeg.
6. **Bad input.** Handlers parse JSON manually (`src/work/http.ts`) with field length limits. Unknown JSON on the socket returns an error frame. This is not schema-wide validation (no Zod/OpenAPI layer).
7. **Permissions.** Organization id comes from the membership, and `authorize()` rejects a mismatch. Chat media and chat subscribe both require conversation membership. This audit did not exercise cross-organization requests with a live token, so this is a code finding, not a penetration-test result.
8. **Timeouts and pools.** App pool `max: 10`, connect timeout 5 s, statement timeout 30 s, idle-in-transaction timeout 60 s (`src/db/pool-config.ts`). HTTP `requestTimeout` is 30 minutes (`src/server.ts`), which covers large uploads and also lets a slow client hold a socket for a long time. Live PostgreSQL `max_connections` is 100. At measurement the application database had 7 backends, 6 idle, 1 active (the audit), 0 waiting on locks.
9. **Concurrency.** Node is single-process for the API. Work mutations are rate limited per user, organization, and IP. Chat publishes after the database commit; a failed publish does not roll back the message (`src/routes/chat.ts`). Client message idempotency (`0066`) is in the working tree and is **not** applied on the live database.
10. **Errors.** Unhandled exceptions return `INTERNAL_SERVER_ERROR` and a request id. Intentional `AppError` text is visible to the client. Logs pass through Pino redaction (`src/config/redaction.ts`) for passwords, tokens, and cookies.

### Chat list versus the earlier Android finding

`GET /api/chat/conversations` already returns `unreadCount`, `lastMessageId`, `lastMessageBody`, `lastMessageType`, `lastMessageSenderId`, and `lastMessageAttachmentName` (`src/chat/store.ts`, serialized in `src/routes/chat.ts`). The backend inbox summary is sufficient for a conversation list. It does not include member profiles or the sender’s name. Extra per-conversation HTTP calls, if Android still makes them, are for those missing fields or for messages, not because the list omits the preview.

### What the database says the API has been doing

`pg_stat_statements` is not installed. `log_min_duration_statement` is `-1` (slow statements are not logged). Since statistics reset on **2026-09-21 14:48 UTC**:

| Signal | Value |
|---|---|
| Transactions committed | 14,431,961 |
| Rolled back | 234 |
| Buffer cache hit ratio | 100.00% (6,377 disk block reads against 1.33 billion hits) |
| Deadlocks | 0 |
| Temp files | 0 |
| `work.time_entries` card index scans | 226,405,377 |
| `identity.sessions` index scans / seq scans | 3,414,345 / 425,628 |
| `work.cards` index scans | 3,375,020 |

226 million index scans on about 4,400 live time-entry rows is roughly **71 scans per second** if spread evenly across the 37 days since the stats reset. The end-of-day job runs once a minute (`src/attendance/scheduler.ts`, `TICK_MS = 60_000`) and cannot explain that rate. The table is 2 MB and fully cached, so this is load, not a current latency incident. Which route generates it is unknown until statement statistics or access logs are kept. Hypothesis: clients or a list endpoint repeatedly resolve time entries by card.

---

## E. Database health

| Item | Evidence |
|---|---|
| Version | PostgreSQL 17.11 (Debian), uptime 33 days at audit |
| Database | `kode_platform_staging`, 53 MB |
| Connections | `max_connections` 100. 7 backends in this database. App pool max 10 per process. Five Node processes can open pools; observed use is far under 100 |
| Memory settings | `shared_buffers` 128 MB, `effective_cache_size` 4 GB, `work_mem` 4 MB, `maintenance_work_mem` 64 MB. These are defaults, coherent with a 53 MB database and a 7.5 GiB host |
| Timeouts on the server | `statement_timeout` 0, `idle_in_transaction_session_timeout` 0. The app sets both on its own connections. Workers and `psql` do not inherit the app pool settings unless they set them |
| Autovacuum | On. Dead tuples on the largest tables were small (time entries 378 dead / 4,429 live; refresh tokens 223 / 7,033). No manual vacuum timestamps; autovacuum has run |
| Slow query log | Off |
| Extensions | `plpgsql`, `btree_gist` only |
| Integrity objects | 455 foreign keys, 123 unique constraints |
| Locks | No session waiting on a lock. No idle-in-transaction session |
| Migrations applied | Latest row `0065_chat_presence.sql`. Earlier rows include bare versions `0062`, `0060`, `0059` alongside full filenames |

### Size and shape

Largest relations are `work.cards` (14 MB, ~6,300 rows), `identity.refresh_tokens` (2.6 MB, **7,033 live tuples**), `work.time_entries` (2.2 MB, ~4,400), `security.events` (1.6 MB), `attendance.sessions` (1.5 MB). Chat relations are tiny: `chat.messages` 104 kB (planner estimate 6 rows; that estimate may be stale), `chat.conversations` 48 kB, `chat.conversation_members` 96 kB. `media_platform.assets` is 128 kB (planner estimate 2 rows) and `media_platform.jobs` 80 kB (estimate 10). Content Studio asset rows are hundreds to about a thousand, not millions.

Counts that describe tenancy, with no personal fields selected:

| Population | Count |
|---|---|
| Organizations | 2 |
| Active memberships | 45 |
| Suspended / pending memberships | 3 / 1 |
| Active user accounts | 44 |

`identity.refresh_tokens` holding about 7,000 live rows for about 44 active users means tokens are retained far past a single session. That is a hygiene and revocation-list growth issue. It is not, by itself, proof that expired tokens are still accepted. The check lives in the session service; this audit did not sample token expiry timestamps.

### Indexes and scans

High sequential-scan counts on small tables (`identity.sessions` 425,628 seq scans, `content.client_media` 48,707, `content.schedule_assets` 58,868, `notifications.notifications` 136,727) are real statistics and, at these row counts, cheap. They are worth a second look when those tables grow, not a reason to rebuild indexes now. `pg_stat_user_indexes` shows several legacy-id indexes with 0 scans (`cards_legacy_source_legacy_id_key` and similar). Unused indexes at this size cost kilobytes.

Bloat was not measured. `pgstattuple` is not installed, and a table scan for bloat was out of scope. Dead-tuple ratios above do not suggest an emergency.

### Models that the product depends on

Schemas are split by domain (`identity`, `organizations`, `work`, `chat`, `attendance`, `leave`, `notifications`, `content`, `documents`, `media_platform`, `meetings`). Organization id is a column and a foreign key on the tenant tables reviewed in migrations. Chat membership is unique per `(conversation_id, user_id)`. Attendance has one active session per user (partial unique index) and one daily row per user and date. Direct-call columns (`0067`) and push subscriptions (`0068`) are **not** in the live catalog. Message client-idempotency (`0066`) is **not** in the live catalog.

Chat store updates use explicit `BEGIN`/`COMMIT` on a checked-out client. Other stores use `withTransaction()`. The pattern is consistent enough for the flows that were read. A full transaction-boundary audit of every store was not done.

### Backup relationship

A database restore without the matching MinIO snapshot would leave chat attachment URLs, Content Studio rows, and `media_platform.assets` pointing at objects that are not there. The 22 September manifest recorded both a PostgreSQL dump (about 12 MB uncompressed) and a MinIO hardlink snapshot (about 7.3 GB). See section H.

---

## E2. Redis and real-time health

Redis is not the system of record. `docs/architecture/backups-and-recovery.md` already says to rebuild it from PostgreSQL. The live instance matches that design.

| Use | Where | Key / TTL | If Redis is down |
|---|---|---|---|
| Login and work rate limits | `src/auth/rate-limit-redis.ts` | `kode:${appEnv}:ratelimit:...`, expires with the window | Fail closed |
| Chat fan-out | `src/chat/hub.ts` `pSubscribe('chat:*')` | Pub/sub, no retention | This one API process still delivers to its own sockets. A second API replica would miss cross-node events. There is only one API process today |
| Presence leases | `src/chat/presence.ts` | Sorted set per org and user, `PEXPIRE` 75 s, heartbeat 25 s | Status `unknown`. Sockets stay up |
| Content media capability | `src/content/redis-capability.ts` | SHA-256 key, default TTL 60 s | Fail closed |
| Playback grants | `src/media-platform/playback/redis-grant.ts` | Grant key plus a per-user set, user-set expiry 86,400 s | Fail closed. Media edge authorization fails |
| Sessions | Not Redis | `identity.sessions` | Unaffected |
| Job queue | Not Redis | `media_platform.jobs` leases in PostgreSQL | Unaffected |

Live Redis, this window:

| Metric | Value |
|---|---|
| `used_memory` | 1.84 MB (RSS about 18 MB) |
| Peak since process start (~21 h) | 1.84 MB |
| `maxmemory` | 0 |
| Policy | `noeviction` |
| Keys | 32, all with TTL, average TTL about 18 minutes |
| Evicted keys | 0 |
| Expired keys | 160 |
| Connected clients | 5 |
| Commands | 35,863 since start, 0 ops/s at the sample |
| Hits / misses | 129 / 436 |
| Pub/sub channels | 0 at the sample |
| AOF | Enabled, last write ok |
| Rejected connections | 0 |

The low hit ratio is expected: the keyspace is grants and rate-limit windows, not a read-through cache of PostgreSQL. There is no second application cache layer in front of Redis for business rows. In-memory fallbacks exist for development and tests (`MemoryRateLimiter`, `MemoryPlaybackGrantStore`, `MemoryFileStorage` if MinIO credentials are absent). The VPS env points at real Redis and MinIO.

Presence expiry is implemented: each connection id is a sorted-set member, scores older than the TTL are removed, and the key itself has a 75 s expiry. The socket interval closes the connection when no heartbeat arrives within 75 s. That logic is in source. Live presence key counts were not dumped (that would list user ids).

### WebSocket behavior

| Question | What the code does | What was measured |
|---|---|---|
| Authentication | JWT verified, session loaded, account must be active, before the socket is registered | Unauthenticated `GET /ws/chat` on localhost returned 401 |
| Subscriptions | Client must send `subscribe`. `isMember(conversation, user, organization)` runs first. `unsubscribe` removes that conversation from the connection’s set. `onClose` deletes the connection | No live socket count. 8 established TCP connections on port 3000 at one snapshot, which includes Caddy keepalives and any sockets |
| Heartbeat | Client `ping` every 25 s re-reads the session and refreshes the Redis lease, then sends presence snapshots | Not timed live |
| Fan-out | Redis channel per conversation, or local delivery if publish fails. Presence is per organization, not per conversation | 0 pub/sub channels at a quiet sample. Pattern-subscription count was not collected |
| Ordering and duplicates | One delivery path when Redis publish succeeds (the subscriber calls local delivery). No server replay buffer | Clients recover by reading `GET .../messages`. Persist succeeds even if publish fails |
| Missed events on reconnect | No replay. Idempotent `client_message_id` is source-only until migration `0066` is applied | Live database does not have that unique index |
| Unauthorized rooms | Non-members get an error frame and are not added | Code path reviewed, not probed with a second user |
| Isolation from HTTP | Same process and event loop. Hub start failure is logged and does not exit the process. Presence errors are caught per socket | A stuck CPU loop on a socket would stall HTTP. No such loop was identified in the handlers that were read |
| Credential exposure | Query-string token is accepted | App access log field is `c.req.path` (no query). Pino redacts `access_token` when it appears as a structured field. Live proxy logs were not readable |

**Capacity.** This audit does not estimate a maximum WebSocket population. Inputs that would be required (per-socket RAM, heartbeat query cost under load, file-descriptor use) were not measured. The only snapshot is 8 established connections on port 3000 and an API resident set of about 260 MiB with the pool almost idle.

**Mitigation that preserves current clients.** Keep accepting the query token until mobile and web both send a header or a `Sec-WebSocket-Protocol` value. In parallel, confirm whether Caddy’s access log includes the raw URI and, if it does, redact the query on `/ws/chat` before the log is written. A follow-up change can require the first client frame to carry the token and then reject query tokens once every shipped client has moved. That change is not part of this stage.

---

## G. Media and LiveKit health

Three pipelines are live and should stay separate.

### 1. Chat attachments (keep this path)

- Buckets `chat-images` and `chat-attachments` (`src/chat/buckets.ts`).
- Object key is organization, conversation, and file id.
- `POST` stores the object and writes an API URL onto the message, not a public MinIO URL (`src/routes/chat.ts`).
- `GET /api/chat/media/...` requires the session, the chat permission, a bucket allowlist, and conversation membership. Legacy unscoped keys are accepted only when a message row links them.
- Bytes are streamed from MinIO with the client’s `Range` header. The client supports 200, 206, and 416 (`src/files/minio-storage.ts`, `src/content/media-stream.ts`).
- This path does not use media-edge, the playback worker, or the media-platform worker.

### 2. Content Studio

- Bucket `content-review-assets`.
- Metadata in `content.schedule_assets`, `content.client_media`, and resumable upload tables (`0064` is applied).
- Browser and device downloads use a short-lived capability (`cap`) on `GET /api/content-studio/media`, which is the one API path skipped by the session middleware.
- Legacy worker writes `.playback/v1/{sha256}.mp4` beside the original and deletes its temp directory in a `finally` block. One scanner at a time via advisory lock `71402819`. Failures are logged and the outer loop sleeps 5 minutes. The running worker is the one with the 1.12 GiB peak and heavy CPU throttle.
- Upload maintenance runs every 300 s and is a separate container.

### 3. Media platform / edge

- Tables `media_platform.assets`, `variants`, `jobs` (migration `0058` applied).
- Worker claims one job, lease 90 s, heartbeat 30 s, timeout 30 min, `max_attempts` default 3. Scratch is cleaned in `finally`. Duplicate processing of the same asset is blocked by the claim query.
- Implemented job types are `playback_mp4` and `adaptive_hls`. `thumbnail` and `metadata` are rejected in `src/media-platform/processing-worker.ts`.
- Delivery is a signed `/media/v2/...` URL plus a Redis grant. nginx `auth_request` calls media-auth, which checks the signature and the grant, then reads MinIO with `Range`. Range responses bypass the nginx cache (`deploy/media-edge/nginx.conf`).
- Edge listens on `127.0.0.1:3100` only. External TCP to 3100 timed out.

Job queue depth, failure counts, and processing latency are not exported. The jobs table is about 80 kB. No queue-age alert exists.

Storage growth of MinIO objects was not measurable (volume directory not readable). The 22 September snapshot was about 7.3 GB. Current object size may be larger. 89 GB free on the filesystem is the only current capacity signal, and it includes everything else on the disk.

### LiveKit

Configuration actually loaded is `/opt/livekit/livekit.yaml` (29 lines), mounted by `/opt/livekit/docker-compose.yml`:

- Image `livekit/livekit-server:v1.12.0`, `network_mode: host`, `restart: unless-stopped`.
- Port 7880 for signaling. Comment in the file: Caddy terminates TLS for `meet.itsnomatata.com` and proxies to 7880. External TCP to 7880 timed out. HTTPS to the name returned `OK` in 1.23 s. That agrees with the comment. The live Caddyfile was not opened.
- RTC TCP 7881 is publicly reachable. `use_external_ip: true`. `allow_tcp_fallback: true`. UDP range 50000–60000 is configured and was **not** probed.
- TURN enabled, domain `meet.itsnomatata.com`, UDP 3478, TLS 5349, `external_tls: true`. TCP 5349 is publicly reachable. UDP 3478 was not probed.
- API key **name** in the file is `devkey`. The secret is 64 characters and is not the literal sample value `secret`. The secret was not printed and was not compared to other public examples. A well-known key id with a private secret is a naming risk, not a demonstrated compromise.
- Application tokens are minted in `src/meetings/livekit.ts` (HS256, about 2 hours, `roomJoin`). Meeting rooms are `meeting:{id}`. Direct-call rooms in source are `call:{id}`.
- Meeting “signals” in PostgreSQL are application events (mute, camera, remove), not WebRTC SDP.
- Ending a meeting updates `status` and `ended_at`. Nothing in this repo deletes the LiveKit room. An abandoned room depends on LiveKit’s own empty timeout. That timeout was not present in the 29-line yaml, so LiveKit defaults apply and were not confirmed live.
- CPU at the snapshot was low (about 1.5% for a 62-day process, 86 MiB resident). Low CPU with 2 signaling connections does not describe how the host behaves with several concurrent camera calls. Mobile encode/decode happens on the phone. Bandwidth and the untested UDP range are the open questions.

---

## H. Security and resilience

Classification key: **confirmed vulnerability**, **configuration risk**, **missing control**, **needs verification**.

| Finding | Class | Evidence |
|---|---|---|
| Backups stopped on 2026-09-22 and exist only on this disk | Confirmed recovery gap (availability) | Newest file under `/var/backups/itsnomatata` is the 02:00 UTC manifest and a 9.7 MB archive. MinIO snapshot directory is 7.0 GB. No backup timer in `systemctl list-timers`. `/etc/cron.d` has only `e2scrub_all`. Manifest `stack_path` is `/opt/itsnomatata-api/stack` |
| Same-disk backup cannot survive loss of the VPS or the disk | Confirmed recovery gap | Path is `/var/backups` on `/dev/sda1`, the only data disk |
| No restore drill recorded in the repo or on the host paths this account can read | Missing control | `docs/architecture/backups-and-recovery.md` states the procedure is not an implemented product. This audit did not restore anything |
| API listens on `0.0.0.0:3000` under host networking | Configuration risk, currently filtered from this network | `docker-compose.vps.yml` sets `HOST: 0.0.0.0`. External TCP timed out. A firewall change or an IPv6 listener would expose cleartext HTTP. Re-test from outside after any firewall edit, including IPv6 |
| WebSocket access token accepted in the query string | Configuration risk; log exposure needs verification | `readAccessToken` in `src/routes/chat-ws.ts`. App log uses path only. Proxy log format unread |
| LiveKit API key id is `devkey` | Configuration risk | `/opt/livekit/livekit.yaml`. Secret length 64, not the sample secret `secret` |
| Public API runs with `APP_ENV=staging` | Configuration risk | Health JSON and compose. Production branch in `src/config/env.ts` that requires `DATABASE_SSL` / `REDIS_TLS` and rejects placeholder token secrets is not active. Database and Redis are on loopback, which limits the TLS gap. Cookie `Secure` is still on outside development |
| Redis `noeviction` and no `maxmemory`; several containers uncapped; no swap | Configuration risk | `CONFIG GET` and cgroup `memory.max`. No OOM in cgroup counters so far |
| `/health/ready` only checks PostgreSQL | Missing control | `src/routes/health.ts`. Redis, MinIO, workers, and LiveKit can be down while readiness stays 200 |
| No global rate limit on `/api` | Missing control | Limiters cover auth and work mutations. Current traffic does not show lockups or connection rejection |
| Attendance geofence constant is `false` | Missing control, documented as intentional until site coordinates are confirmed | `src/attendance/geofence.ts` lines 18–22. Clock-in does not read office pins while this is false. Deployed bytecode was not disassembled; the constant is in the tree the VPS was built from historically |
| Refresh-token table ~7,000 rows for ~44 active users | Needs verification | `pg_stat_user_tables.n_live_tup`. Expiry enforcement was not sampled |
| Organization isolation | Reviewed in code, not penetration-tested | `authorize()` compares organization ids. Chat membership query includes organization id. No cross-tenant read was attempted |
| Secrets in the repo working tree | Needs verification of who can read the checkout | `.env.vps` is on the developer machine and is gitignored. It was not copied into this report. Server env files were not printed |
| Public product ports | Needs verification for UDP | TCP 443, 7881, and 5349 are open by design for HTTPS, LiveKit TCP fallback, and TURN TLS. UDP media ports were not tested |
| Schema files `0067` and `0068` on the server, not applied; `0066` absent | Needs verification | `platform.schema_migrations` max is `0065_chat_presence.sql`. Unauthenticated `/api/*` returns 401 for real and fake paths, so route presence in the running image is unproven |
| Pino redaction and generic 500s | Control present | `src/config/redaction.ts`, `src/middleware/error-handler.ts` |
| Datastores not published | Control present from this network | TCP timeout on 5433, 6379, 9000, 9001 |

### Failure behavior (from source and from what is running)

| Failure | Expected behavior | Verified live? |
|---|---|---|
| API container exit | Caddy returns 502. WebSockets drop. Workers keep running. `restart: unless-stopped` should recreate the API. Restart policy is in compose; Docker state was not readable, so recreate-on-failure was not watched | No |
| PostgreSQL down | `/health/ready` 503. Authenticated API calls fail. Workers stop making progress | Ready path works while Postgres is up. Outage not induced |
| Redis restart | Brief fail-closed on rate limits and media grants. Chat falls back to local fan-out. Sessions remain in PostgreSQL. Presence goes `unknown` until leases return. AOF is on | Not induced. AOF status ok |
| MinIO down | Uploads and downloads fail. Chat text and other SQL writes continue | Not induced |
| Playback worker crash | Compose restart. Advisory lock releases when the session ends. In-flight temp dir cleanup depends on `finally` running. A kill -9 can leave `/tmp` files on a tmpfs that disappears with the container | Not induced. Process is up |
| Media-platform worker crash | Lease expires (90 s) and another claim can retry, up to 3 attempts | Not induced |
| Network blip to a client | HTTP calls fail until retry. WebSocket closes. Missed events are recovered by REST, not by a server buffer. LiveKit depends on ICE restart on the client; server room cleanup is LiveKit’s | Code only |
| Disk full | PostgreSQL, MinIO, AOF, and logs all stop cleanly or not at all. 89 GB free today. Journal is already 2.1 GB. A new full MinIO copy beside the 7 GB snapshot would fit once and would not fit many times | Not induced |
| VPS reboot | `unless-stopped` on the compose services and on LiveKit. Host has been up 63 days, so reboot behavior was not observed in this window | No |
| LiveKit down | `meet.itsnomatata.com` would fail. Token route would still mint a JWT if the API’s secret is configured; clients would then fail to connect. Meetings rows in PostgreSQL would still update if the API is up | Not induced |

RPO and RTO are not defined in the repository. The only observed successful backup is 36 days old, so the practical RPO today is “since 22 September,” and the RTO is unknown because a restore has not been timed.

---

## I. Redundant architecture

| Item | Classification | Why |
|---|---|---|
| API, serving PostgreSQL, Redis, MinIO, Caddy, LiveKit | Active and required | Public traffic and live processes |
| Chat REST + `/ws/chat` + Redis presence | Active and required | Implemented and mounted. Volume of messages is small; the path is still the product path |
| Conversation-list subqueries for unread and last message | Active and required | This is what lets clients avoid N HTTP calls. Cheap at current row counts |
| Legacy playback worker and media-platform worker | Duplicated pipelines, both active | Different outputs (`.playback/v1` MP4 versus `.media/v2` generations). Both processes are running. Retiring either one needs a consumer check in web and mobile, not a CPU argument |
| Content Studio capability URLs and media-edge signed URLs | Duplicated delivery mechanisms with different consumers | Capability route is the API stream. Edge is the CDN. Chat uses neither |
| Two extra PostgreSQL postmasters | Unknown | No clients, capped CPU and RAM, up 19 days, not published. Consistent with a restore or a migration rehearsal. Names were not readable. Do not remove them on resource-usage grounds |
| `express` dependency | Potentially obsolete | No `src/` import found. Not proven unused by scripts |
| Infrastructure control-center server target | Potentially obsolete on this host | No process seen. Code and compose target still exist |
| Legacy `*_legacy_source_legacy_id` indexes with 0 scans | Potentially obsolete | Small. May still serve a migration tool that has not run since stats reset |
| In-memory stores (`MemoryFileStorage`, memory rate limiter, memory grants) | Active for development and tests | Production path uses Postgres, Redis, and MinIO when env is set. The VPS env is set |
| `deploy/Caddyfile.example` and `docker-compose.production.example.yml` | Active as documentation only | Live proxy config is not this file |
| End-of-day scheduler inside the API process | Active and required | Attendance auto clock-out and time-entry auto-stop every 60 s |
| Query-string WebSocket auth | Active but inefficient as a security control | Works. Puts tokens where URLs get logged |
| Per-request session query plus auth-context query | Active but inefficient | Correct, two round trips, hidden by cache |
| Time-entry card index at ~71 scans/s | Active but inefficient, caller unknown | Functional. Telemetry has to name the caller before anyone rewrites it |
| Thumbnail / metadata job types | Confirmed unused in the worker | Schema allows them. Worker throws. No evidence a client depends on the output |
| `/api` routes that only exist in the working tree (`0066` idempotency) | Unknown on the running image | Not in the live database |

Nothing in this list should be deleted as part of a cleanup pass until the consumer check in section M is done. Low CPU is not evidence of death. The playback worker spends most of its time idle and has still done real transcoding.

---

## J. Performance evidence

### Actual measurements (this window)

- Host: 4 vCPU, 7.56 GiB RAM, 5.68 GiB available, load 0.22 / 0.32 / 0.47, CPU PSI ~1% some, memory and I/O PSI 0, no swap, disk 39% and inodes 9%.
- Cgroup memory and throttle figures in the inventory table.
- Playback worker: 38.6% of CPU periods throttled over 29 days, peak 1.12 GiB of a 1.5 GiB cap.
- PostgreSQL: 53 MB, 100.00% cache hit, 14.4 million commits and 234 rollbacks since 21 September, 0 deadlocks, 7 backends, 0 lock waits.
- Redis: 1.84 MB, 32 keys, `noeviction`, 0 evictions.
- Health: 1.0 ms and 1.4 ms on localhost; 0.87 s and 0.65 s from the auditor network (one sample each).
- Port exposure results in section B.
- Backup tree newest timestamp 2026-09-22 02:00 UTC.
- Tenancy: 2 organizations, 45 active memberships, 44 active users.

### Confirmed in code or configuration

- Middleware order, pool of 10, 30 s statement timeout, 30 min HTTP timeout, 60 s end-of-day tick.
- Chat list shape includes last message and unread count.
- WebSocket query-token acceptance, membership check, 25 s heartbeat, 75 s presence TTL, no replay buffer.
- Redis fail-closed versus chat fail-open, as tabulated.
- Three media pipelines and their authorization.
- LiveKit yaml: ports, TURN, `devkey`, external IP, no room-delete in the application.
- `APP_ENV=staging` on the public API.
- Geofence enforcement constant `false`.
- Ready check covers PostgreSQL only.
- Migrations applied through `0065`; `0067` and `0068` files present and not applied; `0066` file absent on the server checkout.

### Reasoned hypotheses

- The 226 million time-entry index scans are client or list-endpoint traffic, because the scheduler is once a minute. The table is too small for this to explain user-visible slowness by itself.
- External health latency is path latency. Local health is 1 ms, so the API process is not adding hundreds of milliseconds to a trivial read.
- The backup job likely stopped when its `stack_path` (`/opt/itsnomatata-api/stack`) stopped being what the job expected, or the scheduler was removed from root’s crontab. Root’s crontab was not readable. This remains a hypothesis about *why*. The stop itself is measured.
- Android inbox slowness, if it is still “one request per conversation,” is a client choice for fields the list does not carry (sender name, members), or a network RTT problem. It is not explained by database size or by a missing preview field.

### Unavailable

- Docker health, restart count, image id, volume bytes, build cache size.
- Kernel log OOM search (account cannot read the journal). Cgroup `oom_kill` is 0.
- Per-route latency, error rate, and caller identity.
- `pg_stat_statements` and slow-query text.
- Live Caddyfile, so body-size limits, timeouts, and log format at the proxy are the example file plus inference from working uploads, not a read of production config.
- UDP 3478 and UDP 50000–60000 reachability.
- IPv6 filter on port 3000.
- Whether the running image contains `/api/calls` and `/api/push` handler code.
- Current MinIO object count and byte size.
- Off-site backup existence. None was visible from this host. An off-site copy could exist somewhere this account cannot see.
- Historical RAM or CPU peaks older than each cgroup’s `memory.peak` (peaks reset when the cgroup is recreated; API/Redis/MinIO peaks cover only ~21 hours).

---

## K. Current VPS capacity

The machine matches the brief: 4 vCPU, about 8 GB, 150 GB disk, Ubuntu, Docker. Measured headroom for the **current** product load is large. Measured headroom for **video transcoding** is the worker quota, which has already been hitting its ceiling. Measured headroom for **disaster recovery** is poor for an unrelated reason (backup age and placement).

What would change the assessment:

| Workload | Would it outgrow this host? | Why, from evidence |
|---|---|---|
| More employees using the existing API, on the order of the current 45 and well beyond | Not on RAM or disk for the API and PostgreSQL, for a long while | 53 MB database, 260 MiB API, 100% cache hit, load 0.2. Connection pool and `max_connections` 100 have room. This is not a forecast of a user count |
| Several concurrent LiveKit camera calls | Unknown, possibly CPU and bandwidth | LiveKit is idle and uncapped. UDP reachability untested. Do not treat 86 MiB idle RSS as call capacity |
| More or longer transcodes | CPU first | Worker already throttled at 1.5 CPU and has approached 1.5 GiB |
| MinIO growth | Disk, once objects leave the tens of GB | 7.3 GB at the last snapshot, 89 GB free now, current object size unread |
| A memory leak or an uncapped Redis | RAM, then the OOM killer, because there is no swap | No leak is in evidence. The caps that would contain one are absent |

### Option A — Keep this VPS

Adequate for the API, PostgreSQL, Redis, and current concurrency. Headroom is visible in available memory (5.7 GiB), load, cache hits, and idle pools. Keeping it requires fixing backups and putting memory and Redis caps in place so one container cannot take the host. It does not require a larger plan to make today’s API faster.

### Option B — Change the backend before adding hardware

Worth doing where the change removes a real defect:

- Restore backups (this is reliability, and it is the first change).
- Cap Redis and the uncapped containers so they cannot consume the whole host.
- Record per-route latency so the time-entry scan rate and any mobile retry storm become visible.
- After clients can send it, stop putting access tokens in WebSocket URLs.
- Leave chat media, the conversation-list shape, and the split between chat buckets and the CDN alone until a measured problem says otherwise.

Rewriting queries, merging endpoints, or moving cache libraries will not show up in user latency while the database stays at 53 MB and localhost health stays at 1 ms. The time-entry index heat should be named by telemetry before it is rewritten.

### Option C — Larger hardware

Justified only for a measured ceiling:

- More CPU, or a higher worker CPU quota on a larger host, if transcoding time is a product problem. The throttle data already supports “this worker cannot use more than 1.5 CPU.”
- More disk, or object storage that is not this volume, when MinIO plus Docker plus backups approach the 89 GB free. That point is not measured yet.
- More bandwidth or a second host for LiveKit if concurrent calls saturate CPU or the uplink. That saturation was not observed.
- More RAM is not justified by anything measured here. Available memory was 5.7 GiB, memory PSI was 0, and cgroup OOM counters were 0. Buying 16 GB would not speed up the API and would not remove the worker CPU cap.

### Staging load test, for a later approval

Do not run this against the public host.

1. Restore the 22 September archive, or a new dump taken under a change window, into an isolated PostgreSQL and MinIO on a machine that is not `128.140.124.44`.
2. Point one API and one of each worker at that copy. Cap the worker at the same 1.5 CPU / 1.5 GiB.
3. Replay a recorded set of authenticated reads: `/api/me`, conversation list, one message page, attendance today, time-entry list. Use throwaway accounts from the restored copy, never production tokens in query strings.
4. Separately, run one and then three LiveKit rooms with the same client build the phones use, on a network that resembles mobile NAT. Record connection success, UDP versus TCP fallback, and host CPU. Stop there.
5. Success criteria: error rate, p95 latency per route, pool wait time, worker throttle, and whether UDP media establishes. Publish the numbers before any resize or rewrite.

---

## L. Prioritized improvement roadmap

| Priority | Finding | Evidence | Proposed action | Risk | Expected benefit |
|---|---|---|---|---|---|
| P0 | Last backup is 2026-09-22 and sits on the only disk | Manifest, `LATEST_OK`, 7.0 GB snapshot, no backup timer | See section M. Re-enable a scheduled dump of PostgreSQL and a MinIO snapshot, copy both off the VPS, alert on failure, restore once into an isolated instance | A careless job can fill the disk or lock the database. Use `pg_dump` and a retention cap. Do not restore over the live instance | A lost VPS becomes recoverable. RPO returns to one day instead of 36 days and counting |
| P1 | Uncapped API, PostgreSQL, Redis, MinIO, Caddy, and LiveKit on a host with no swap. Redis policy `noeviction` | cgroup `memory.max` = `max`; `CONFIG GET maxmemory` = 0; `SwapTotal` 0 | Set Redis `maxmemory` with `volatile-ttl` or `allkeys-lru` (every current key already has a TTL). Set memory caps on the uncapped containers below the host total, leaving room for the kernel. Add a small swap only as a last-resort cushion if operations want one; caps matter more | A cap set below the current peak will restart the container. MinIO peak this cgroup is 665 MiB; size from that, not from the 1.8 MB Redis footprint | One leak fails its own container instead of the host |
| P1 | Playback worker CPU quota is already hot | 38.6% of periods throttled, 4,852 s throttled, 1.12 GiB peak over 29 days | Measure transcode duration from worker logs once those logs are readable. Raise the quota only if jobs miss a product deadline. Keep the memory cap | Raising CPU on this 4-vCPU host takes time from the API and LiveKit during a transcode | Honest capacity for video, instead of a silent throttle |
| P1 | Access token allowed on the WebSocket URL | `src/routes/chat-ws.ts` `readAccessToken` | Confirm Caddy log fields. Redact query strings on `/ws/chat`. Plan a header or subprotocol token, and keep query support until Android, iOS, and web all send the new form | Cutting query support early logs every mobile client out of chat | Tokens stop landing in proxy logs and Referer-like records |
| P1 | Public host is configured as staging | Health JSON `environment=staging`, database name, compose `APP_ENV` | Decide deliberately. Either treat this host as production in config (so production secret and TLS guards apply) or document that “staging” is the public environment and duplicate the guards that matter | Changing `APP_ENV` changes JWT issuer/audience and invalidates sessions | The safety checks written for production actually run on the public API |
| P2 | No per-route metrics, slow-query log off, ready check ignores Redis and MinIO | `log_min_duration_statement=-1`, no `pg_stat_statements`, `src/routes/health.ts` | Lightweight notes in section M’s sibling work: pino is already timing requests; ship those lines to the journal with a size cap, enable `pg_stat_statements`, extend readiness with fast pings. Skip a full Prometheus stack on this host | Log volume. Journal is already 2.1 GB | The 71 time-entry scans/s and any real error rate become visible |
| P2 | Migrations `0067` and `0068` are on disk and not applied; `0066` is missing on the server | `schema_migrations` versus `/opt/kode-platform/migrations` | Before the next API image rolls out, apply the matching migrations in order, or remove the files from the deploy tree if the image does not use them. Do not apply them blindly in this audit | Applying `0067`/`0068` is a schema change and needs its own window and backup | Calls and push either work with their tables, or they are clearly not deployed |
| P2 | ~7,000 refresh tokens for ~44 users | `n_live_tup` on `identity.refresh_tokens` | Confirm expiry is enforced. Delete rows that are expired or revoked, and cap retention | Deleting a still-valid token logs that device out | Smaller blast radius and a smaller table |
| P2 | Geofence code is off | `ATTENDANCE_GEOFENCE_ENFORCED = false` | Leave it off until office coordinates are confirmed, then enable per site. Do not flip the constant as a drive-by | False clock-in rejections if coordinates are wrong | Attendance location checks match the product intent when the data exists |
| P2 | Two extra PostgreSQL instances | Second and third postmasters, 19 days, no clients, 512 MiB and 768 MiB caps | Identify them from Docker names (needs an account in the `docker` group). Keep them if they are a rehearsed restore. Remove them only after that identification and a copy of anything they uniquely hold | Deleting a rehearsal copy someone still needs | Reclaimed RAM, CPU quota, and disk |
| P3 | Auth context is two queries per request; conversation list uses correlated subqueries; HTTP timeout is 30 minutes | `src/auth/middleware.ts`, `src/chat/postgres-store.ts`, `src/server.ts` | Revisit after metrics exist. A short-lived cache of auth context is the only one likely to matter at higher QPS | Stale permissions if the cache outlives a role change | Fewer round trips later, no user-visible change now |
| P3 | Thumbnail jobs are unimplemented; `express` may be unused; example compose files look like a second production | Worker source, `package.json`, `deploy/` | Document ownership. Remove `express` only after a repo-wide import check | Accidental removal of a script dependency | Less dead surface |

---

## M. Recommended next stage

**Restore backup continuity, and prove one restore off this VPS.**

That is the single next engineering action. The API is healthy enough that optimizing it, or resizing the VPS, would spend time on a system that is currently fast and small, while the copy required to rebuild it is 36 days old and stored on the disk that would be lost.

### Purpose

Make PostgreSQL and MinIO recoverable to a known time, on a different machine, with a person having actually done it once.

### Affected components

- Whatever used to write `/var/backups/itsnomatata` (not present as a system timer; the manifest names `/opt/itsnomatata-api/stack`).
- PostgreSQL database `kode_platform_staging` on `127.0.0.1:5433`.
- MinIO data, last captured as a 7.3 GB hardlink snapshot.
- Off-server storage that does not exist in the evidence gathered here.
- Alert path. None exists for backup failure today.

### Required changes

1. Find the old job (likely root’s crontab or a script under `/opt/itsnomatata-api`) and see why it stopped on 22 September. Read-only first.
2. Take a fresh `pg_dump` of `kode_platform_staging` and a MinIO snapshot using the same hardlink approach if it still fits the retention story. Confirm free space first (89 GB free; the previous snapshot was 7 GB of hardlinks plus a 10 MB archive).
3. Copy the dump and enough object data to a second location. A hardlink snapshot that never leaves this disk is not a backup of the disk.
4. Restore both into an empty PostgreSQL and an empty MinIO that are not the live containers. Run the migrations that the dump already includes. Open `/health/ready` against that copy. Check that a known chat attachment key and a known Content Studio object exist in both the dump’s rows and the object store.
5. Schedule the job daily, retain a bounded number of copies, and emit a failure if `LATEST_OK` is older than 26 hours.
6. Write the RPO (one day, unless the schedule says otherwise) and the measured restore duration into `docs/architecture/backups-and-recovery.md`.

Do not restore over the live database. Do not delete the 22 September tree until a newer copy has been restored successfully somewhere else. Do not change application code in this stage.

### Expected benefit

A VPS or disk failure stops being an unrecoverable event. The 36-day gap stops growing.

### Regression risks

- `pg_dump` adds read load. At 53 MB this is small; schedule it at the same 02:00 UTC window the old job used, and watch for lock waits.
- A full MinIO copy instead of hardlinks can consume another ~7 GB or more and, if repeated without retention, can fill the disk. Hardlinks do not protect against `rm` of the live volume.
- A restore pointed at the live ports would destroy current data. The runbook should refuse to run when the target host is `ubuntu-8gb-fsn1-2` or the target port is 5433 on this machine.
- Taking the dump does not fix schema drift (`0066`–`0068`). Leave migrations for a separate change, after a fresh dump exists.

### Validation tests

- Manifest timestamp is from the day of the run.
- Restored database `schema_migrations` max matches the dump.
- Row counts for `organizations.organizations`, `identity.users`, and `chat.messages` match the source counts taken at dump time.
- A sampled object key from `content.schedule_assets` or a chat attachment URL resolves in the restored MinIO and is rejected for a user who is not a member (authorization still belongs to the API, so this last check is on a throwaway API pointed at the copy).
- Deleting the backup destination’s credentials, or stopping the copy step, produces an alert. That failure test can use a dry-run flag; it must not delete the live snapshot.

### Rollback

The live services are untouched if the dump is read-only and the restore target is elsewhere. Rollback of a bad new backup job is to disable the timer and keep the previous artifacts. Rollback of a bad restore is to drop the isolated instance. There is nothing to roll back on the public API if this stage is done as specified.

---

## What this audit did not do

No container was restarted, no migration was applied, no firewall or Caddy file was edited, no load test was sent, and no object was downloaded. Credentials, tokens, and personal rows were not copied into this document. Where Docker or the kernel log blocked a measurement, the cell says so.
