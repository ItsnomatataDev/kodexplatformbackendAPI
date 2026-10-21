# Profile avatar migration (Supabase to VPS)

The profile avatar importer copies Supabase Storage objects into the VPS
`profile-pictures` MinIO bucket and updates `identity.user_profiles.avatar_url`
to the authenticated Kode API. It does not delete or modify Supabase objects.

## Before running

- Run this from the VPS release checkout, not a development environment.
- Ensure the migration process receives the correct `DATABASE_*`, `MINIO_*`,
  and `LEGACY_STORAGE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) values
  through the VPS's approved environment setup.
- `LEGACY_STORAGE_URL` can override the legacy Supabase URL. Otherwise the
  script uses `SUPABASE_URL` or the configured legacy project default.
- Do not paste or commit credentials, and do not run against a local or staging
  database with production storage credentials.
- Keep a current database and MinIO backup before applying the migration.

## Dry run and apply

First inspect the counts without writing anything:

```sh
npm run migrate:profile-avatars
```

The importer only considers avatar URLs on the configured Supabase origin with
standard `object/public`, `object/sign`, or `object/authenticated` storage paths.
Other and already-migrated URLs remain unchanged. Source objects must be raster
images no larger than 5 MiB.

After confirming the counts and configuration, copy files and update profile
URLs:

```sh
npm run migrate:profile-avatars -- --apply
```

If some source objects are already missing, the command reports them and exits
unsuccessfully by default. Re-run with `--allow-missing` only after accepting
that those profiles will keep their legacy URLs:

```sh
npm run migrate:profile-avatars -- --apply --allow-missing
```

The destination object names are deterministic, making interrupted runs
repeatable. Profile URLs are updated only if their source value has not changed
while copying. Confirm avatars in the profile page, employee directory, and
chat after the import.

Migrated URLs use `/api/organization/avatar/file`; requests require a valid
Kode bearer token and an active membership in the avatar owner's organization.
Confirm the frontend loads these URLs with its authenticated API client. A
plain HTML `<img src>` request cannot attach the required bearer token; update
the frontend image-loading path before applying if it does not already fetch
avatar bytes with authorization.
