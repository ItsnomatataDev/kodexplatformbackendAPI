# Authentication

Kode Platform owns authentication. Supabase Auth is not part of the runtime
path.

```
HTTP request
  → Credential verification (password, refresh token, or access JWT)
  → authenticated user ID
  → resolveAuthContext(userId)
  → AuthContext from PostgreSQL
  → authorization
  → route / service
```

The client never establishes user identity, organization, role, or permission.
PostgreSQL remains authoritative.

See also `docs/architecture/core-engineering-standards.md`.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| `POST` | `/auth/login` | Public (rate limited) |
| `POST` | `/auth/refresh` | Refresh token (rate limited) |
| `POST` | `/auth/logout` | Access token |
| `POST` | `/auth/logout-all` | Access token |
| `POST` | `/auth/password/change` | Access token |
| `POST` | `/auth/password/reset/request` | Public (rate limited) |
| `POST` | `/auth/password/reset/confirm` | Public (rate limited) |
| `GET` | `/auth/csrf` | Public |
| `GET` | `/api/me` | Access token |
| `GET` | `/health/live` | None |
| `GET` | `/health/ready` | None |

## Login

`POST /auth/login`

```json
{ "email": "user@example.com", "password": "..." }
```

1. Normalize email (`trim` + lowercase).
2. Look up `identity.users` by `email_normalized`.
3. Verify the password with Argon2id against `identity.password_credentials`.
4. Unknown accounts and wrong passwords both return `INVALID_CREDENTIALS`
   (`Authentication failed.`). The API does not say whether the email exists.
5. Suspended / inactive / unapproved accounts are denied after a correct
   password.
6. `resolveAuthContext(userId)` loads membership, role, and permissions.
7. A server-side session and hashed refresh token are stored.
8. A short-lived access JWT is issued. `sub` is the user id. Optional `sid` is
   the session id for logout correlation only — not authorization.
9. `auth.login.success` or `auth.login.failure` is published.

Password verification always runs against either the stored hash or a dummy
Argon2id hash so missing accounts do not fail faster than real ones.

## Password hashing

Passwords are hashed with **Argon2id** (`argon2` library, unique salt per hash).

Parameters:

- `type`: argon2id
- `memoryCost`: 19456 (19 MiB)
- `timeCost`: 2
- `parallelism`: 1
- `hashLength`: 32

Plaintext passwords are never stored or logged. Hashes are never returned.

Password rules: 12–128 characters, must not equal the account email.

## Access tokens

Unchanged JWT architecture:

- HS256 via `jose`
- issuer `kode-platform/<APP_ENV>`
- audience `kode-platform-api/<APP_ENV>`
- `token_use=access`
- `sub` = `identity.users.id`
- default lifetime **900 seconds (15 minutes)**, configurable 60–3600
- organization, role, and permissions are **not** authoritative claims

After logout, an access token may remain cryptographically valid until `exp`.
Refresh and new logins are blocked because the session is revoked.

## Sessions

Table `identity.sessions`:

- `id`, `user_id` (FK), `created_at`, `expires_at`, `last_seen_at`
- `revoked_at`, `revocation_reason`
- `ip_address`, `user_agent`

Active-session lookup is indexed. Session lifetime matches the refresh TTL
(default 7 days).

Reusable revocation lives in `SessionService`:

- logout
- logout-all
- password change
- password reset
- account suspension / deactivation
- refresh-token replay
- future administrator/security actions (`onAccountAccessRevoked`)

## Refresh tokens

Opaque 256-bit random values (base64url), sent in the JSON body and as an
HttpOnly `kode_refresh` cookie (`Path=/auth`, `SameSite=Lax`, `Secure` outside
development).

They are stored as HMAC-SHA256 hashes, never plaintext.

Default lifetime: **7 days** (`AUTH_REFRESH_TOKEN_TTL_SECONDS`, 1 hour–30 days).

### Rotation and replay

```
login → access + refresh
access expires → POST /auth/refresh
verify unused hashed token
mark used, insert replacement, issue new access + refresh
```

If a **used** refresh token is presented again:

- the request is rejected (`REFRESH_TOKEN_REPLAY`)
- the whole session is revoked
- `auth.session.replay_detected` is recorded

No new tokens are issued.

## Logout

`POST /auth/logout` revokes the session identified by the access token `sid`.

`POST /auth/logout-all` revokes every active session for the authenticated
user. The client cannot supply a target user id.

Refresh stops immediately. Access JWTs expire on their own short TTL.

## Password change

`POST /auth/password/change`

- authenticated user only
- current password required
- new password hashed with Argon2id
- all sessions revoked
- a fresh session is issued
- `auth.password.changed` is published

## Password reset

`POST /auth/password/reset/request` accepts an email and always returns a
generic success message.

`POST /auth/password/reset/confirm` accepts `{ token, new_password }`.

Reset tokens are random, hashed, 30 minutes by default, single-use. After
success, the password is updated, all sessions are revoked, outstanding reset
tokens are invalidated, and `auth.password.reset.completed` is published. The
user must log in again.

### Email limitation

No email provider is configured. `UnconfiguredEmailSender` is a real boundary
that does **not** deliver mail and does **not** put the reset token in the API
response or logs. Tests inject `CapturingEmailSender`. Until a provider is
wired, production reset emails will not be sent.

## Rate limiting

Interface: `RateLimiter.consume(key, limit, windowSeconds)`.

Protected:

| Endpoint | Keys | Limit / 15 min |
|---|---|---|
| `/auth/login` | IP, email | 10 / 5 |
| `/auth/password/reset/request` | IP, email | 5 / 3 |
| `/auth/password/reset/confirm` | IP | 10 |
| `/auth/refresh` | IP | 30 |

This is throttling, not account lockout.

**Redis is the shared production backend.** Staging and production use
`RedisRateLimiter`. If Redis is unavailable there, those endpoints return 503
`RATE_LIMIT_UNAVAILABLE`.

Development may use an in-memory limiter explicitly labeled non-production.
That implementation refuses to construct unless the caller passes `development`
or `test`.

## CSRF

State-changing requests (`POST` / `PUT` / `PATCH` / `DELETE`):

- If `Origin` is present, it must be on the environment allowlist.
- If a `Cookie` header is present (browser credentials), `Origin` is required
  and must be allowed. When `kode_csrf` is set, `X-CSRF-Token` must match
  (timing-safe).
- Native/mobile clients sending `Authorization: Bearer` without cookies are not
  forced through cookie CSRF; CORS still blocks disallowed browser origins.

`GET /auth/csrf` issues a CSRF cookie/token for browser clients.

CORS is not a CSRF control. CSRF is origin + double-submit.

## CORS

`CORS_ALLOWED_ORIGINS` is an exact allowlist. `*` is rejected.

- Development defaults to loopback origins only.
- Staging cannot use production hostnames.
- Production cannot use loopback.

Authenticated CORS never uses `Access-Control-Allow-Origin: *`.

## Security headers

Applied to every response:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; ...`
- `Cross-Origin-Resource-Policy: same-site`
- `Cross-Origin-Opener-Policy: same-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Cache-Control: no-store`
- `Strict-Transport-Security` on staging and production only (not local HTTP)

## Security events

Published through the existing event boundary (no secrets):

`auth.login.success`, `auth.login.failure`, `auth.logout`, `auth.logout_all`,
`auth.session.created`, `auth.session.revoked`, `auth.session.refresh`,
`auth.session.replay_detected`, `auth.password.changed`,
`auth.password.reset.requested`, `auth.password.reset.completed`.

Payloads may include user id, session id, request id, timestamp, failure
category, IP, and user-agent.

Logs redact passwords, hashes, tokens, cookies, and `Authorization`.

## Account lifecycle

| Status | Login | Refresh | Existing sessions |
|---|---|---|---|
| active | allowed | allowed | remain until expiry/revocation |
| suspended | denied | denied + all sessions revoked | revoke via `onAccountAccessRevoked` |
| inactive / deleted | denied | denied + all sessions revoked | same |

Authorization still re-checks account status on privileged routes.

## Environment separation

`AUTH_TOKEN_SECRET`, issuer, audience, and CORS origins are per `APP_ENV`.
Development secrets must not be used in staging/production. Production rejects
`change_me` token secrets. Do not reuse production secrets.

## Mobile

Web may keep the access token in memory and the refresh token in the HttpOnly
cookie. Mobile stores both credentials itself and sends:

- `Authorization: Bearer <access>`
- `POST /auth/refresh` with `{ "refresh_token": "..." }`

Mobile does not make authorization decisions. MFA is not implemented; the login
service issues a session only after password success, which is the insertion
point for a future MFA challenge.

## MFA (future)

Not implemented. Intended sequence:

```
password → MFA challenge → createAuthenticatedSession()
```

Authorization and `AuthContext` do not need to change.

## Development helpers

```bash
npm run auth:issue-dev-token -- --user-id <identity.users.id>
npm run auth:bootstrap-password -- --user-id <identity.users.id>
```

Both commands refuse to run unless `APP_ENV=development`. They are not available
in staging or production.

`auth:bootstrap-password` attaches a Kode password to an **existing**
`identity.users` row so local engineers can exercise `POST /auth/login`. It
does not create users and does not change identity, organization, membership,
role, or profile data. The password is prompted interactively (never as a CLI
argument) and hashed with the same Argon2id parameters as normal password
create/change. Replacing an existing credential requires `--force`.

Prefer login over `auth:issue-dev-token` once the account has a password
credential.

### Production passwords are not migrated

Supabase Auth password hashes are **not** copied into Kode. Migrated production
identity rows will not have a usable `identity.password_credentials` secret
until the user completes a future secure Kode password setup/reset flow. Do not
use the development bootstrap command to provision production passwords.

## Known limitations

- Email delivery for password reset is not configured.
- Redis rate limiting is required for staging/production auth abuse controls.
- Access JWTs are not denylisted; they die at `exp` after logout.
- No MFA, social login, or magic link.
- Production user password setup/reset email is not implemented yet.
