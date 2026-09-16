# Kode Platform Core Engineering Standards

This document is the engineering contract for Kode Platform.

Kode Platform is the permanent, production-grade backend foundation. It is not
a temporary Supabase replacement and must not be designed as a stopgap.

Do not optimize for speed by cutting architectural corners. Build the foundation
so the application can migrate from Supabase without unexpected behavioral or
data changes for users.

The system must support current application users, web, mobile, future Kode AI,
future workers/automation, future integrations, and future scaling.

---

## 1. Environments

The platform has exactly three isolated environments:

| Environment | `APP_ENV` | Purpose |
|---|---|---|
| Development | `development` | Local API, local PostgreSQL, local Redis, local MinIO, test/dev data |
| Staging | `staging` | Isolated rehearsal, integration, security, Burp, and load testing |
| Production | `production` | Real users and real data |

`APP_ENV` is required. Do not infer the platform environment from `NODE_ENV`
alone.

Copy the matching example file:

- `.env.development.example`
- `.env.staging.example`
- `.env.production.example`

Never:

- connect development tooling to production
- reuse production database or object-storage volumes in staging or development
- allow staging to modify production
- use production credentials locally
- start production without `ALLOW_PRODUCTION=true`

Environment guards in `src/config/environment-guards.ts` must fail closed when
these rules are violated. See `docs/architecture/environments.md`.

---

## 2. Architecture

```
PostgreSQL        system of record
Redis             cache / queues / event transport
MinIO             object/file storage
Kode Platform API authentication context / authorization / business rules / API
Workers           background processing
Kode              intelligence / automation
LiveKit           real-time media
```

The API is the central business boundary. Clients, workers, integrations, and
Kode reach business operations through the API.

This is a modular monolith. Do not introduce Kubernetes, microservices, Kafka,
service meshes, or extra distributed infrastructure without a concrete need.

---

## 3. Authentication and authorization

Authentication belongs to Kode Platform. See
`docs/architecture/authentication.md`.

The request flow is:

```
HTTP request
  → authentication (verify credential → userId)
  → resolveAuthContext(userId)
  → AuthContext
  → authorization
  → route / service
  → PostgreSQL
```

Do not trust a client-supplied user id or organization id. Do not add a
permanent Supabase Auth dependency.

Authorization belongs to Kode Platform.

Do not copy Supabase RLS as the application authorization architecture.
Do not depend on the frontend for authorization.
Do not trust `organization_id` supplied by clients.

The server determines:

- authenticated user
- organization membership
- role
- permissions
- ownership
- resource organization
- whether the requested operation is allowed

Rules:

- Load identity and membership from PostgreSQL after authentication succeeds.
- Use `src/authorization` for every privileged operation.
- Use the server-resolved membership organization id, never a client-supplied
  tenant id, as the authority for organization scope.
- Deny cross-organization access by default. There is no silent superuser bypass.
- Deny suspended, inactive, rejected, and deleted accounts.
- Deny inactive, pending, suspended, and removed memberships.
- Fail closed: if permission is not explicitly granted, deny.

Route handlers must not scatter one-off permission checks. Domain services call
`assertAuthorized()` (or `authorize()` when a decision object is required).

---

## 4. Multi-tenancy

Organization isolation is a core security requirement.

Every organization-owned domain must have an explicit `organization_id`
relationship. Database foreign keys should reinforce this wherever practical.

Resources belonging to Organization A must never be accessible to Organization B.
Queries that load tenant-owned rows must include the server-resolved
organization id. Do not load a row by id alone and then “check org later” unless
`src/authorization` still compares the row’s stored organization id to the
authenticated membership.

---

## 5. Database

PostgreSQL is authoritative.

Use primary keys, foreign keys, unique constraints, check constraints, indexes,
timestamps, explicit nullability, and transactions.

Do not rely exclusively on application code to maintain data integrity.
Do not blindly reproduce the legacy Supabase schema. Model the actual business
domain.

---

## 6. Migrations

All schema changes use versioned SQL files in `migrations/`:

```
0001_platform_core.sql
0002_ingestion.sql
0003_identity_organizations.sql
0004_work.sql
```

Future domains continue sequentially. Do not modify completed migrations unless
there is a genuine correction that requires explicit handling.

`npm run migrate` must detect applied migrations, apply the rest in order, fail
safely, never skip failures, and print clear output.

---

## 7. Legacy data migration

Supabase is a legacy source, not the runtime foundation.

```
Legacy export
  → raw ingestion
  → normalization
  → validation
  → mapping
  → deduplication
  → quality review
  → target database
  → reconciliation
```

Preserve `legacy_source` and `legacy_id` on migrated business records.
Never silently discard legacy records.

Every migration report must include source, imported, rejected, duplicate,
orphan, relationship-error, and unresolved quality-issue counts.

Do not connect migration tooling to production unless that is an explicit,
guarded production operation.

---

## 8. Transactions

Important multi-record operations must use PostgreSQL transactions.

Use `withTransaction()` in `src/db/transaction.ts`. The callback receives a
`PoolClient`. Never mix `client.query()` and `pool.query()` / `db.query()`
inside the same transaction.

Business operations that create or update related records must have a clearly
defined transactional boundary.

Domain events are published only after the transaction commits.

---

## 9. API architecture

Keep the API organized by responsibility:

```
src/
  app.ts
  server.ts
  config/
  middleware/
  http/
  auth/
  authorization/
  db/
  routes/
  events/
  files/
  services/        (add with the first business domain)
  repositories/    (add with the first business domain)
  validation/      (add with the first business domain)
  domains/         (add with the first business domain)
  workers/         (add when background jobs land)
```

Routes coordinate requests.
Services implement business operations.
Repositories handle persistence.
Validation is reusable.
Authorization is centralized.

Do not put business rules in route handlers.

---

## 10. Domain architecture

Domains stay independently understandable. Examples: identity, organizations,
work, support, attendance, leave, documents, chat, meetings, content,
notifications, fleet, AI.

Do not create a giant monolithic service file.
Do not split into microservices until scale requires it.

---

## 11. Kode AI boundary

Kode must not receive unrestricted database access.

```
Kode
  → controlled capability/tool
  → Kode Platform API
  → authorization
  → business rules
  → PostgreSQL
```

The model must not bypass authorization. The API stays model-agnostic so Kode
can evolve (1B → 2B → 3B → 10B → 20B+) without redesigning the platform.

---

## 12. Events

Business events follow:

```
API
  → PostgreSQL transaction
  → commit
  → event publication
  → Redis
  → workers / Kode / notifications
```

Redis is not the system of record. Event delivery is not the authoritative
source of business state.

Use `src/events` to publish. The transport may start in-process and later use
Redis without changing domain call sites.

---

## 13. Files

Files move from Supabase Storage to MinIO.

Do not store large binary files in PostgreSQL. Store metadata and object
references (`src/files/object-reference.ts`). File authorization is enforced by
the API, not by a public bucket policy alone.

---

## 14. Observability

Required now:

- structured logging (`pino`)
- request ids (`X-Request-Id`)
- useful, non-leaking error messages
- migration logging
- database health checks
- liveness: `GET /health/live`
- readiness: `GET /health/ready`

Do not log passwords, authentication secrets, access tokens, or credentials.

Prepare for future metrics and tracing. Do not add a metrics stack until there
is a concrete consumer.

---

## 15. Security

Security is part of the foundation.

Staging is the environment for destructive and invasive tests, including Burp.
Never run those scenarios against production.

The system must eventually be tested for authentication bypass, authorization
bypass, IDOR, cross-organization access, privilege escalation, suspended-user
access, unauthenticated endpoint access, malformed input, SQL injection, file
authorization, session problems, and rate abuse.

Current non-negotiable controls:

- parameterized SQL only
- centralized authorization
- server-resolved organization scope
- fail-closed permissions
- environment isolation guards
- secret redaction in logs
- production start requires `ALLOW_PRODUCTION=true`

---

## 16. Backups and recovery

PostgreSQL backups, object-storage backups, backup verification, restore
testing, and a documented recovery procedure are required before production
data is authoritative.

A backup that has never been restored is not verified.
Do not implement fake backup functionality.

See `docs/architecture/backups-and-recovery.md`.

---

## 17. What not to build yet

Do not introduce:

- Kubernetes
- unnecessary microservices
- Kafka
- service meshes
- a custom ORM
- a second database as a system of record

unless a concrete requirement exists.

---

## 18. Implementation order for new work

1. Keep this foundation intact.
2. Authentication produces a verified user id, sessions, and `AuthContext`.
3. Wire email delivery for password reset, then Redis-backed rate limiting in staging.
4. Add one business domain at a time under `src/domains/<name>`.
5. Migrate that domain’s legacy data only after schema, authorization, and
   reconciliation reports are in place.

Do not start Support, Attendance, or another data migration until that
domain’s service structure is designed.
