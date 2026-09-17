# Production deployment topology (example only)

This is infrastructure preparation. It does not deploy Kode, change DNS, or
enable live HTTPS by itself.

## Intended traffic path

```text
Internet
  → HTTPS reverse proxy (only public service)
    → Kode API (private network, HOST=0.0.0.0 inside the container)
      → private PostgreSQL
      → private Redis
      → private MinIO
```

The example compose marks the data-store network `internal: true` so those
containers cannot be published accidentally. If PostgreSQL, Redis, or MinIO
are managed TLS services outside Docker, attach the API to a network that can
reach those private endpoints instead of using an internal-only network.

## Public vs private

Public:

- reverse proxy on ports 80/443

Private:

- Kode API
- PostgreSQL (no host port)
- Redis (no host port)
- MinIO API and console (no host port)

Attachment bytes stay behind API authorization. Clients never receive a public
object URL as the access control mechanism. Do not create a public bucket
policy.

## Trusted proxy

Set `TRUSTED_PROXY_IPS` to the reverse proxy’s private address or CIDR.

- Accept `X-Forwarded-For` / `X-Real-IP` only from that proxy
- Do not set `TRUSTED_PROXY_IPS=0.0.0.0/0`
- Do not trust forwarding headers from arbitrary internet clients

## TLS

Production process config fails closed unless:

- `DATABASE_SSL=true`
- `REDIS_TLS=true`
- MinIO endpoint is `https://`
- Redis and MinIO credentials are real secrets, not placeholders

Optional CA files:

- `DATABASE_SSL_CA_FILE`
- `REDIS_TLS_CA_FILE`
- `MINIO_TLS_CA_FILE`

Certificate verification is never disabled. If a private CA is required,
provide the CA file. Do not commit certificates or private keys.

The example Caddyfile terminates HTTPS at the proxy. The API does not need to
terminate TLS itself.

## Containers

Build the API image:

```bash
docker build -f Dockerfile .
```

Run migrations with the same production database TLS settings:

```bash
docker run --rm --env-file /run/secrets/kode.env kode-api node dist/cli/migrate.js
```

The runtime image:

- is multi-stage
- runs as a non-root user (`kode`, uid 10001)
- does not bake `.env` or secrets
- includes production `node_modules` only
- exposes `/health/live`, `/health/ready`, and `/health`

`/health/live` is process-alive only. `/health/ready` checks PostgreSQL.

## MinIO image pin

Development compose keeps the currently working local MinIO image so existing
volumes are not disrupted.

Production must not use `:latest`. Pin an official MinIO release tag or digest
at deploy time. The production compose example uses
`minio/minio:REPLACE_WITH_PINNED_RELEASE` as a reminder, not a runnable tag.

## Rate-limit namespace

Redis keys are `kode:${APP_ENV}:ratelimit:...` so development, staging, and
production cannot share buckets even on a mis-pointed host.

## Related files

- `Dockerfile`
- `docker-compose.production.example.yml`
- `deploy/Caddyfile.example`
- `.env.production.example`
