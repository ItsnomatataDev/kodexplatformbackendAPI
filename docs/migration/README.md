# Kode Platform Data Migration

## Purpose

Migrate required user and business data from the legacy Supabase/PostgreSQL
system into Kode Platform without losing user data.

The legacy system is a migration source only. Kode Platform is the new
runtime system.

## Migration principles

- Never modify legacy production data during migration.
- Never connect development or staging to production databases.
- Do not recreate the legacy schema wholesale.
- Preserve required user and business data.
- Transform legacy structures into clean Kode Platform domain models.
- Validate every migration.
- Record rejected, duplicated, invalid, and unresolved records.
- Do not consider a migration complete until source and target data have
  been reconciled.

## Classification

Each legacy table will receive one classification:

- MIGRATE
- TRANSFORM
- MERGE
- REPLACE
- ARCHIVE
- DISCARD

## Initial migration order

1. Organizations
2. Users / Profiles
3. Organization memberships
4. Roles and permissions
5. Application domains
6. Files and documents
7. Historical/audit data
8. Remaining legacy data requiring preservation

## Migration lifecycle

Legacy export
    ↓
Raw ingestion
    ↓
Normalization
    ↓
Validation
    ↓
Mapping
    ↓
Deduplication
    ↓
Quality review
    ↓
Target database
    ↓
Reconciliation
    ↓
Migration sign-off
