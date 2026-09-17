# kodexplatformbackendAPI

Kode Platform is the production backend for the system: PostgreSQL as the
system of record, Redis for cache/queues, MinIO for files, and a Hono API as
the authentication, authorization, and business boundary.

## Environments

Copy the matching example file to `.env`:

```bash
cp .env.development.example .env
```

`APP_ENV` must be `development`, `staging`, or `production`.

## Local development

```bash
docker compose up -d
npm install
npm run migrate
npm run dev
```

## Checks

```bash
npm run typecheck
npm run test
npm run check
npm run build
npm run verify:env
```

Architecture notes live in `docs/architecture/`.
Production container and reverse-proxy examples live in `deploy/README.md`.
Do not use `docker-compose.yml` for production.
