# Backups and Recovery

This is architecture and operating procedure, not an implemented backup product.
Do not add application endpoints that pretend to back up or restore data.

Kode Platform is not production-authoritative until backups exist, a restore has
been tested, and this procedure matches the actual infrastructure.

## What must be backed up

| System | Role | Backup target |
|---|---|---|
| PostgreSQL | System of record | Logical dumps and/or provider snapshots, per environment |
| MinIO | Object/file storage | Bucket versioning and/or object replication, per environment |
| Redis | Cache / queues / transport | Not a restore source for business state. Rebuild from PostgreSQL. |

Do not back up development volumes into staging or production.
Do not restore production backups into development without an explicit,
redacted copy process.

## Environment isolation

Each environment has its own PostgreSQL instance, Redis instance, MinIO
instance, and volumes.

- Development uses local Docker volumes named for development only.
- Staging volumes must never be production volumes.
- Production restore targets production infrastructure only.

## Verification standard

A backup is not considered verified until:

1. It was taken by the documented job or snapshot process.
2. It was restored into an isolated target (normally staging).
3. Restoration produced a usable database (schema migrations present, identity
   tables queryable, row counts reconcilable for a known dataset).
4. The restore time and operator are recorded.

## Recovery procedure (to be executed when infrastructure exists)

### PostgreSQL

1. Identify the environment (`APP_ENV`) and refuse to continue if it does not
   match the intended restore target.
2. Take a pre-restore snapshot of the damaged instance if it is still reachable.
3. Restore the verified backup into the isolated target instance.
4. Run `npm run migrate` so schema_migrations matches the application revision.
5. Run `npm run verify:env` and `GET /health/ready`.
6. Reconcile critical counts (organizations, users, memberships, then the
   affected domain).
7. Record the incident, backup identifier, and restore result.

### MinIO

1. Confirm the bucket name matches the environment (`kode-dev`, `kode-staging`,
   `kode-production`).
2. Restore objects into that environment’s bucket only.
3. Confirm application object references still resolve.
4. Confirm file access is still authorized by the API.

### Redis

Do not restore Redis as business state. After PostgreSQL is healthy, allow
caches and queues to rebuild. Drain or discard poisoned queues rather than
replaying unverified jobs against production data.

## Current status

Infrastructure-specific tooling (snapshot schedules, offsite retention, restore
drill cadence) is not implemented in this repository yet. Until it is:

- Treat this document as the required design.
- Do not store durable production data without an external backup owner.
- Rehearse restores in staging, never as an experiment in production.
