# Read-only migration compatibility inspection

Prepared 2026-10-08; **not executed on the VPS**. An authorized operator must perform this separately. Do not run `npm run migrate`, `applyMigrations`, schema repair, ledger INSERT/UPDATE/DELETE or any deployment command during this inspection.

## Capture

Use an existing authenticated psql connection, preferably a SELECT-only role with catalog visibility. Do not copy credentials, env files or connection strings into this repository or reports. Review [inspect-ledger.sql](../../scripts/media-platform/inspect-ledger.sql) before use. It opens `BEGIN READ ONLY`, sets short lock/statement timeouts, reads ledger/schema metadata and commits. It creates nothing. A missing ledger or permission error is a STOP condition, not a reason to initialize a table.

With the reviewed SQL accessible to the operator, run through the existing approved connection mechanism:

```sh
psql -X -qAt --set=ON_ERROR_STOP=1 --file=inspect-ledger.sql > ledger.json
```

No host, password or production connection settings are supplied by this procedure. `-X` disables psql startup scripts; `-qAt` leaves only the JSON result. Store the metadata report with restricted access. Also capture a read-only filename inventory and SHA-256 checksums of migration SQL and the deployed runner; inspect its release/commit identity. Do not synchronize files over the running checkout. Compare immutable 0058 media and 0059 leases SQL and the historical time-entry SQL with the candidate release. An old time-entry 0058 must match candidate 0060 byte-for-byte.

## Evaluate offline

In the candidate local release, after `npm run build`:

```sh
node scripts/media-platform/check-ledger.mjs /restricted/path/ledger.json
```

This checker imports only the pure migration planner, reads local JSON/filenames and opens no database connection. It reports pending identities, **not schema compatibility approval**. Unknown history exits nonzero. Review the captured columns alongside migrations 0058–0061; inspect catalog constraints/indexes separately if any drift is suspected. A ledger alone cannot prove SQL was actually applied.

Expected histories (assuming 0001–0057 match):

| Ledger | Expected pending identities |
| --- | --- |
| numeric 0058 `media_platform`, 0059 `media_job_leases` | 0060 time-entry, 0061 fencing |
| numeric 0058 `time_entry_auto_stop` | 0058 media, 0059 leases, 0061 fencing |
| already reconciled filename entries | None for the identities already recorded |

Check media tables/lease columns against the recorded migrations; `work.time_entries.auto_stopped_at` must exist when time-entry migration is recorded. Fencing requires job/asset `fencing_token`, asset `hls_generation`/`playback_generation`, variant `generation` and the bigint sequence. Missing columns, manually created media tables without ledger rows, conflicting descriptions, both aliases for one migration, unexplained pending early migrations, obsolete duplicate migration files or mismatched historical SQL all require operator reconciliation. Do not guess, auto-backfill, reset sequences or rewrite applied history.

## Approval evidence

Attach the sanitized pending plan, schema comparison, SQL checksum comparison and release identity to the change review. Both legacy histories and this read-only query are exercised against disposable PostgreSQL fixtures; the real VPS remains uninspected. Rehearse the candidate runner on an isolated restored database before any production migration approval. The reconciled runner must accompany the release: old numeric-only runners cannot safely interpret filename ledger identities.
