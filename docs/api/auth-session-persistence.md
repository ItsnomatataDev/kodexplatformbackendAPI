# Persistent login and token refresh

## Findings

There is no backend mouse/keyboard inactivity logout rule. Access JWTs expire (currently one hour); a valid saved refresh cookie must renew authentication. Attendance clock-out is separate and must not sign the user out of the app.

Code inspection identified three failure paths:

- The request body's refresh token took precedence over the shared HttpOnly cookie. A sleeping tab could submit an old per-tab token even though another tab had already refreshed the cookie. Outside the 30-second grace, that revoked the entire session as replay.
- Refresh tokens and cookies gained a new expiry at rotation, but the database session retained its original login deadline. The session could expire despite regular successful refreshes.
- Refreshes were checked outside the write transaction, and concurrent reuse relied on a process-local cache indexed by session. Different workers or a restart could return a terminal 401 for a valid concurrent refresh. The cache also returned credentials before checking whether logout or suspension had revoked the session.

These findings explain possible failures in the module; no particular deployed user's logout has been attributed from live logs.

## Backend behavior

The shared `kode_refresh` cookie now takes precedence. Body-only clients still work when no refresh cookie exists. An invalid cookie is rejected rather than silently switching identity to a body token.

Successful rotation commits the successor, consumes the previous token, and renews session expiry in one transaction. The configured `AUTH_REFRESH_TOKEN_TTL_SECONDS` remains the lifetime: currently **604800 seconds (7 days) since the last successful rotation**. A session that is not refreshed for the full lifetime requires another login. Existing already expired or revoked sessions are not restored by this release.

Concurrent refreshes lock the database session and re-read the token after obtaining that lock. Within the existing 30-second grace they recover the same current successor, including after a worker restart. Successors are derived with a domain-separated HMAC using the server secret, previous raw token, and a newly random replacement UUID. Only token hashes remain in PostgreSQL; no raw or encrypted refresh-token storage was added. Access JWTs keep their existing expiry and validation.

Replay outside grace still revokes the session. Sign-out, sign-out everywhere, password reset/change, suspension, deletion, and inactive-account checks remain effective. Account/context validation happens before consuming a refresh token, so a temporary lookup failure does not strand the client. Authentication persistence uses the same policy for every role; normal API authorization remains unchanged.

## API and browser integration

Existing endpoints and success response fields are unchanged:

1. On application startup, including a new morning tab with empty session storage, obtain `GET /auth/csrf` with `credentials: 'include'`.
2. Call `POST /auth/refresh` with `credentials: 'include'`, the current `X-CSRF-Token`, and `{}` when no body token exists. No access JWT is required. The browser sends its saved HttpOnly refresh cookie.
3. Save the returned access token/expiry, load `GET /api/me`, and restore the user, organization, and role. Protected routes must wait until restoration finishes before redirecting to login.
4. Refresh before access expiry and on focus/wake. Coordinate in-flight refreshes across tabs and use the current cookie. Routine lack of mouse/keyboard activity must not clear authentication.
5. Treat **409 `REFRESH_CONFLICT`** as retryable: retry with the current shared cookie after the in-flight refresh completes. This can occur during deployment for tokens rotated by the previous code. Do not clear the session on this response, a network failure, rate limiting, or a server error. Use bounded retries and a visible recovery state when connectivity remains unavailable.
6. Preserve CSRF protections. Re-fetch CSRF and retry once on `CSRF_TOKEN_INVALID`. Clear authentication on confirmed expired/revoked credentials, explicit logout, or an account access denial; do not manufacture a user or a successful login.

The nearby frontend already attempts cookie restoration and periodic/focus refreshes. It was inspected but not edited during this backend task. Deployed browser verification remains necessary, including cookie acceptance with the actual frontend/API domains. A backend cannot restore a cookie that the browser has blocked or deleted. Auto-login restores authentication only; it does not auto-clock attendance in or resume a task timer.

## Deployment

This authentication fix needs **no new database migration or token-secret change**. It does not require invalidating existing valid sessions.

On 2026-10-05, the operator's terminal output confirmed that the five authentication source files were uploaded, the API image rebuilt successfully, and `kode-vps-api` recreated. An immediate readiness request returned 502. A subsequent external check at 10:01 UTC returned HTTP 200 with `status: "ok"`, `environment: "staging"`, and `checks.database: "ok"`. This confirms service readiness; the deployed idle/overnight browser tests below remain outstanding.

From the local Mac:

```sh
cd /Users/thando/Desktop/devprojects/kode-platform
rsync -av --files-from=scripts/deploy/auth-session-files.txt ./ root@128.140.124.44:/opt/kode-platform/
ssh root@128.140.124.44
```

On the VPS, continue only after each command succeeds:

```sh
cd /opt/kode-platform
docker compose --env-file .env.vps -f docker-compose.vps.yml build api
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --no-deps --force-recreate api
curl --fail --retry 10 --retry-delay 2 --retry-max-time 45 --max-time 10 https://api.tmctechsolutions.com/health/ready
```

Recreating the container briefly interrupts the upstream API. The readiness command retries transient responses such as 502 while the replacement starts. If it still fails, inspect `docker logs --tail 100 kode-vps-api` before attempting another deployment.

To release the separate 18:00 attendance/timer fix too, upload its `scripts/deploy/end-of-day-files.txt` manifest and run the migration step in [attendance-time-auto-stop.md](attendance-time-auto-stop.md) before recreating the API. That release requires migration 0058; this authentication-only manifest does not upload it.

After deployment, verify using real accounts: stay idle past access expiry, wake a second tab with an older body token, close/reopen the browser the next morning, and confirm `/api/me` returns the correct identity and role. Also confirm explicit logout does not auto-restore. Do not share raw token/cookie values in logs.

## Verification

```sh
npm run build
npm run typecheck
npm test
DATABASE_NAME=kode_obligations_leave_test npm run test:auth-session:postgres
```

Use a disposable migrated database. The PostgreSQL suite performs real login/refresh/logout HTTP requests, actual token/session writes, and concurrent transactions. It covers all 15 operating/legacy roles, expired access tokens, idle/overnight restoration, sliding expiry beyond the original deadline, stale body tokens, concurrent workers/restarts, legacy rotation conflicts, CSRF, replay revocation, suspension, expired sessions, transient lookup failure, and transaction rollback through a database trigger. Fixtures are removed afterward; database unavailability fails the explicitly opted-in command.
