# Kode Platform Environments

Kode Platform has three isolated runtime environments. `APP_ENV` is required and
must be exactly `development`, `staging`, or `production`.

Configuration examples:

- `.env.development.example`
- `.env.staging.example`
- `.env.production.example`

Copy the matching file to `.env`. Never copy production values onto a
development machine. Runtime guards in `src/config/environment-guards.ts` exist
to catch the obvious mistakes; they do not replace operator discipline.

## Development

`APP_ENV=development`

Used for:

- local API development
- database development
- ingestion development
- unit tests
- integration tests

Infrastructure is local only:

- PostgreSQL on `127.0.0.1` (Docker publishes `127.0.0.1:5433`)
- Redis on `127.0.0.1`
- MinIO on `127.0.0.1`
- API bound to `127.0.0.1`

Guards:

- PostgreSQL, Redis, and MinIO hosts must be loopback
- API host must be `127.0.0.1` or `localhost`
- database name must start with `kode_` and must not contain `staging` or `production`
- MinIO bucket must not contain `staging` or `production`
- `ALLOW_PRODUCTION` must not be `true`
- `AUTH_TOKEN_SECRET` is required (32+ characters). Development may use the
  documented `dev-only-...` placeholder.

`docker-compose.yml` is development-only. Its volumes (`kode_postgres_data`,
`kode_redis_data`, `kode_minio_data`) must never be reused for staging or
production.

## Staging

`APP_ENV=staging`

Used for:

- integration testing
- migration rehearsal
- end-to-end testing
- security testing
- Burp Suite testing
- load testing
- release validation

Staging has its own PostgreSQL, Redis, MinIO, and API.

Guards:

- database name must contain `staging` and must not contain `production`
- MinIO bucket must contain `staging` and must not contain `production`
- hosts and endpoints must not contain `production`
- `ALLOW_PRODUCTION` must not be `true`
- `AUTH_TOKEN_SECRET` is required and must not use a `dev-only` development secret

Staging may run on loopback only when names/buckets still identify staging.
That still requires separate data volumes from development.

Never use production credentials in staging.

## Production

`APP_ENV=production`

Contains real users, real business data, real files, and production workloads.

Guards:

- `ALLOW_PRODUCTION=true` is required to start
- database name must contain `production` and must not contain `staging`
- MinIO bucket must contain `production` and must not contain `staging` or equal `kode-dev`
- PostgreSQL, Redis, and MinIO hosts must not be loopback
- `AUTH_TOKEN_SECRET` is required, at least 32 characters, and must not use
  `dev-only` or `change_me` placeholders

Production is never an experimental migration environment.

## Data boundary

Legacy Supabase is not part of the new runtime architecture.

It is a controlled migration source:

```
Legacy Supabase
    → export / migration tooling
    → development
    → staging
    → production
```

## Service ownership

| System | Ownership |
|---|---|
| PostgreSQL | System of record |
| Redis | Cache / queues / event transport |
| MinIO | File/object storage |
| Kode Platform API | Authentication / authorization / business rules |
| Kode | Intelligence / automation, through the API only |
| LiveKit | Real-time media |

## Verification

```bash
npm run verify:env
```

This command loads the same runtime configuration the API uses. If isolation
guards fail, the process exits non-zero and prints no secrets.
