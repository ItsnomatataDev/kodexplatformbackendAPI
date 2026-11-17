# IT's No Matata — Stage BH-2.2: Production Backup Readiness

Date: 28 October 2026. This stage corrects the backup and restore scripts and tests them on disposable PostgreSQL 17 and MinIO. It does not deploy anything, create a live role, change permissions, run a production backup, or restore production.

**Recommendation: NO-GO for production deployment.**

The scripts now authorize the real production source and still refuse to restore onto it. Disposable tests passed, including a full recovery from an encrypted set. Deployment stays blocked because the live MinIO size is still unmeasured, no off-site bucket exists, the backup role does not exist on the serving database, and the retention lock has not been chosen. A 14-day object lock does not provide six months of backups.

## 1. Corrected scripts

| File | Role |
| --- | --- |
| `deploy/backup/backup-set.sh` | Build one encrypted set |
| `deploy/backup/source-policy.sh` | Production and drill source rules |
| `deploy/backup/restore-drill.sh` | Isolated restore |
| `deploy/backup/hold-snapshot.py` | Shared database snapshot and reference list |
| `deploy/backup/sql/kode_backup_role.sql` | Scoped backup role, for a later approval |
| `deploy/backup/test-readiness.sh` | Disposable test suite |

## 2. Changes made to the scripts

BH-2.1 refused the production hostname and database inside the backup script, so the job could not back up the system it was written for. Those checks now depend on the mode.

`KODE_BACKUP_MODE=production` runs only when every one of these is true:

- hostname `ubuntu-8gb-fsn1-2`
- database `127.0.0.1:5433`, database name `kode_platform_staging`, user `kode_backup`
- container `kode-vps-postgres`, stack `kode-platform-vps`
- MinIO alias `kode-backup-read`
- backup root `/var/backups/kode-platform`
- rclone remote pinned in `/etc/kode-backup/destination.pin`, and not a local path
- no age identity in the environment

It refuses user `postgres`, `kode_staging`, or a Supabase role, database `postgres`, a stack or container name that points at Supabase, a destination containing `128.140.124.44` or the public API hostnames, and any write under `/var/backups/itsnomatata` or `/opt/itsnomatata-api`.

`KODE_BACKUP_MODE=drill` is the opposite boundary. It requires loopback, a container that is not `kode-vps-*`, and an alias that is not `kode-backup-read`. It refuses port `5433` and database `kode_platform_staging`. `KODE_BACKUP_CHECK_ONLY=1` evaluates the production tuple and exits before any connection. The disposable tests use that to simulate the production source. They do not open a connection to the VPS.

Restore was not relaxed. `restore-drill.sh` still refuses the production host, any database host that is not loopback, port `5433`, database `kode_platform_staging`, users `postgres`, `kode_staging`, and `kode_backup`, and a MinIO URL that is not loopback. It requires `KODE_RESTORE_CONFIRM=isolated` and a PostgreSQL 17 `pg_restore` inside a non-production container.

The backup role no longer uses `pg_read_all_data`. On PostgreSQL 17 that membership could `SELECT pg_authid`, including the fact that password hashes were present. The SQL file grants `USAGE` and `SELECT` per schema on `kode_platform_staging` only, plus default privileges for tables `kode_staging` creates later. The running script refuses to continue if that role can read `pg_authid`, if it cannot read a user table in the target database, or if it can read a user table in any other database.

Other script corrections:

- `pg_dump` and `pg_restore` must be the PostgreSQL 17 client inside the named container. The dump uses `--snapshot` from a repeatable-read transaction that also lists object references.
- `set -o pipefail` is on. A failed dump cannot be published. Passwords go through a mode `600` pgpass file and are removed afterwards. They are not passed as `docker exec -e PGPASSWORD`.
- Object names stay in the encrypted index. The public manifest has counts, sizes, ciphertext SHA-256, and reference counts.
- `LATEST_OK` is renamed into place only after the remote check. A failed run deletes its local staging and does not move the marker. The same stamp is refused if a set already exists. A later stamp is the retry.
- Resource bounds are `nice -n 19`, `zstd -3 -T1`, one object at a time, and rclone `--transfers 1 --bwlimit 8M`. After the object list, the script refuses to continue if free space minus the staging estimate would fall under 20 GiB. The estimate is object bytes plus one third plus 4 KiB per object plus 5 GiB.
- The script does not call `mc rm`, `mc mirror`, `pg_restore`, or SQL that drops or deletes source data.

## 3. Automated test results

`deploy/backup/test-readiness.sh` reported `ALL_PASS 47` on disposable PostgreSQL 17 and two loopback MinIO processes. Production addresses were refused before any connection. The suite then stopped those processes.

| Case | Result |
| --- | --- |
| Production-source check-only with the expected tuple | Authorized, no connection |
| Wrong database, Supabase user, wrong pin, destination aimed at the VPS, age identity present, Supabase stack | Refused |
| Production mode on this workstation | Refused on the hostname, no connection |
| Role SQL on PostgreSQL 17 | Dump contains the table; `pg_authid` is permission denied; a table created later by `kode_staging` is readable; a table in another database is not |
| Read-only MinIO user | `mc rm` Access Denied, `mc pipe` insufficient permissions |
| Drill aimed at the production database, port, public IP, or `postgres` user | Refused |
| Missing age recipient | Exit 2 |
| Large object present | Exit 3, no `LATEST_OK` |
| Complete set, empty bucket, zero-byte object | Published. Public manifest has no object keys and no config secret. `profile-pictures` count 0. Empty object plain size 0 |
| Reference to `missing/object.txt` and an unparsed chat URL | Backup still completes. Manifest `missing` and `unparsed` are at least 1. SHA-256 of the ciphertext still matches |
| Restore of that set onto a second MinIO and empty database | 2 card rows, attachment bytes match, zero-byte object restored, missing object not invented, config secret decrypts |
| Failed dump, vanished object, failed age, interrupted upload, connection reset, remote checksum mismatch | Previous `LATEST_OK` unchanged. Checksum failure left no complete manifest |
| Restore of the incomplete set | Refused |
| New stamp after failure | Becomes the marker. Repeating that stamp exits 2 |
| Free-space gate with a fake 1 GiB volume | Exit 6, marker unchanged |
| Object etag changed between list and stat | Set completes, `replaced` is at least 1, checksums still match |
| Restore to a public IP, port 5433, or a MinIO URL on `128.140.124.44` | Exit 2 |

## 4. Production-source safety model

A production backup is allowed only as an explicit mode with the source tuple above and a pinned remote. Check-only can evaluate that tuple on another machine and cannot proceed into a dump. The job reads with `kode_backup` and `kode-backup-read`. It does not use the application password or the MinIO root key. It does not restore, delete, migrate, or write to the old Supabase tree.

The database dump is limited to `kode_platform_staging` by three controls: the command names that database, the grants exist only there, and the script stops if this role can select a user table anywhere else. `PUBLIC` can still connect to other databases. Connection is not the same as reading their tables. Revoking `CONNECT` from `PUBLIC` is a separate approval because it can lock out administrative tools.

## 5. Restore-destination safety model

Restore refuses the production host even for a loopback database, because port `5433` on that host is the serving database. It also refuses a non-loopback Postgres host, port `5433`, the production database name, the production and backup login roles, a production container name, and a MinIO endpoint that is not `127.0.0.1` or `localhost`. The drill must set `KODE_RESTORE_CONFIRM=isolated`. The restore client is PostgreSQL 17 inside the disposable container. The production write passwords are not in the script.

## 6. Remaining risks and limitations

These are four different claims. A passing SHA-256 proves only the first.

| Claim | What this backup shows |
| --- | --- |
| Encrypted artifact integrity | SHA-256 of every retained `.age` file, checked again by `rclone check --download` |
| Object inventory | All seven buckets are listed, including empty ones. The ciphertext file count matches the listed object count. A listed object that disappears before it is read fails the run |
| Database-to-object references | Same snapshot as `pg_dump` lists known reference columns. Missing, replaced, in-progress, and unparsed counts are in the public manifest. The keys are only in the encrypted consistency file |
| Application recoverability | Not established. The disposable restore checked rows and bytes. It did not start the API or test chat authorization |

The reference check covers ticket attachments, employee documents, content-studio media and schedule assets, media-platform assets and variants, work-card attachments, branding logo and favicon keys, and chat attachment URLs in the two shapes the API writes. Branding keys are assumed to live in `organization-branding`. Upload sessions that are not `completed`, and media assets still `uploading`, are `in_progress` rather than missing. A URL that matches neither chat shape is `unparsed`. A replaced etag does not fail the set: the ciphertext is the bytes that were read, and the manifest says the object changed during the window.

That does not close the window. Preventing it needs bucket versioning or delayed deletion, which are separate approvals and were not enabled.

`kode_backup` will miss a table created by a role other than `kode_staging` until the grants are repeated. The script fails closed if it finds such a table. Large objects still fail the run. Production had zero on 28 October 2026.

The age identity is not on the VPS. Losing both offline copies makes every set unreadable. An upload credential that can also `GetObject` can download ciphertext and still cannot decrypt it.

## 7. Current storage measurement

Read-only `df` on `ubuntu-8gb-fsn1-2` at this stage:

| | Bytes |
| --- | --- |
| Filesystem size | 160,921,083,904 |
| Used | 59,827,793,920 |
| Available | 94,518,353,920 |

Available space is 88.0 GiB. The SSH account `servercontrol` cannot run Docker (`docker` exit 1). It cannot read the MinIO volume, and the earlier signed metrics request returned HTTP 403. A recursive listing of the seven buckets was not started. The live object total is still unknown.

The free-space gate stays. Staging need is object bytes + object bytes / 3 + 4 KiB per object + 5 GiB. The run refuses if available space minus that need is under 20 GiB. With 88.0 GiB free, a set that needs more than about 68 GiB of headroom will refuse. That is a ceiling, not a measurement of MinIO.

Upload time at the configured limit is object bytes / 8 MiB/s, plus the small database stream. It cannot be calculated until the byte count exists. The CPU bound is one `zstd` thread at `nice -n 19`. The network bound is 8 MiB/s, about 64 Mbit/s, so the copy does not take the whole link. The effect on LiveKit is that long transfer, not a second full-speed copy. Duration remains unknown without the object size.

## 8. Off-site destination requirements

No remote is configured. The destination is still a private Hetzner Object Storage bucket in a project that contains only that bucket, with Object Lock enabled at creation and Compliance retention. Hetzner access keys see every bucket in the project. Compliance cannot be shortened. It does not survive the end of the contract. `CopyObject` works only inside one bucket, so a second bucket is a second upload. Server-side encryption is not a substitute for age. Backblaze B2 remains the alternative when the upload key itself must lack delete.

A 14-day Compliance lock protects a daily set for 14 days. It does not protect a monthly set for six months. The earlier mix of 14 daily, 4 weekly, and 6 monthly sets is withdrawn until the lock matches the promise.

Consistent choices, pick one in its own approval:

| Policy | Lock | What is actually kept |
| --- | --- | --- |
| A. Daily only | Compliance 14 days on one bucket | 14 daily sets. No monthly claim |
| B. Six-month archive | Compliance 180 days on one bucket | Every daily set for 180 days, because the dailies cannot be deleted early either. Storage is about 180 sets |
| C. Split | 14 days on the daily bucket and 180 days on a monthly bucket | 14 dailies, plus 6 monthlies uploaded a second time. Two credentials |

The job never deletes remote objects. Expiry is a separate approval and uses a credential the VPS does not have. The upload key needs `PutObject` and `GetObject` so the daily check can stream the ciphertext back. A second read key, stored with the age identity and not on the VPS, is what recovery uses after the VPS is gone.

## 9. Deployment commands, not executed

None of the following were run.

1. Read-only size, from an account that can read MinIO without listing every object body. Stop if this account is still `servercontrol` with no Docker access. Do not walk every object to answer the size question.

```sh
# NOT EXECUTED
df -B1 /
# A bucket-level size from the MinIO admin API or a read-only mc du,
# only after a credential that is not the application root key exists.
```

2. Harden historical backups without moving them.

```sh
# NOT EXECUTED
chmod 700 /var/backups/itsnomatata
chmod -R go-rwx /var/backups/itsnomatata
```

3. Create the age key off the server. Copy only `recipient.pub` to the VPS.

4. Create the bucket with Object Lock at creation, after choosing policy A, B, or C. Confirm the upload key cannot delete a locked probe.

5. Write `/etc/kode-backup/destination.pin` with the rclone remote, mode `600`.

6. Create the role. This is a production database change and needs its own approval.

```sh
# NOT EXECUTED
psql -h 127.0.0.1 -p 5433 -U kode_staging -d kode_platform_staging \
  -v kode_backup_password='...' \
  -f deploy/backup/sql/kode_backup_role.sql
```

7. Create MinIO user `kode-backup-read` with `s3:GetBucketLocation`, `s3:ListBucket`, and `s3:GetObject` on the seven buckets. Confirm `mc rm` is denied. Do not use a delete call as the test if the policy might be wrong; review the policy document first.

8. Install the scripts and run one set only after the size gate passes.

```sh
# NOT EXECUTED
KODE_BACKUP_MODE=production \
KODE_BACKUP_ROOT=/var/backups/kode-platform \
KODE_OFFSITE_DIR=/var/backups/kode-platform/staging \
KODE_RCLONE_REMOTE="$(tr -d '\n' < /etc/kode-backup/destination.pin)" \
KODE_SOURCE_STACK=kode-platform-vps \
KODE_PG_DOCKER_CONTAINER=kode-vps-postgres \
PGHOST=127.0.0.1 PGPORT=5433 PGUSER=kode_backup PGDATABASE=kode_platform_staging \
MC_SOURCE_ALIAS=kode-backup-read \
AGE_RECIPIENT="$(cat /etc/kode-backup/recipient.pub)" \
  deploy/backup/backup-set.sh
```

The unit must not set `AGE_IDENTITY`, `KODE_BACKUP_ALLOW_LOCAL_OFFSITE`, or `KODE_BACKUP_CHECK_ONLY`.

9. On another machine, download that set and run `restore-drill.sh` with `KODE_RESTORE_CONFIRM=isolated` against empty local Postgres and MinIO. Then start the application against that copy and check chat authorization. That step is also not executed.

## 10. Rollback and failure behavior

- A failed run sets its state to `failed`, deletes local staging, and leaves `LATEST_OK` on the previous complete stamp.
- The same stamp cannot be reused once a local or remote set exists. The next night uses a new stamp. Partial remote objects stay until their lock expires. The VPS job has no delete.
- `DROP ROLE kode_backup` removes the backup login. Application sessions use `kode_staging`.
- Removing the MinIO backup user leaves the application credentials in place.
- Disabling the timer leaves uploaded sets where they are.
- `chmod 755 /var/backups/itsnomatata` is the rollback for the permission step. It does not touch the Caddy directory or the two extra Postgres volumes.
- A lost VPS is recovered from a `complete` manifest, the offline age identity, and the offline read key, on a machine the restore script accepts. The newest incomplete stamp is skipped.

## 11. GO / NO-GO

**NO-GO for production deployment.**

The backup implementation is ready to rehearse. It is not ready to turn on. These approvals are still separate, and each one is required before the timer exists:

1. Choose retention policy A, B, or C and create the locked bucket.
2. Generate the age identity and store both copies off the server.
3. Measure MinIO bytes with a read-only account that is not forced to walk every object, and pass the free-space gate.
4. Apply `deploy/backup/sql/kode_backup_role.sql` on the serving instance only.
5. Create the read-only MinIO user.
6. Run one manual set, then one isolated restore that includes the application authorization check.
7. Only then install the 02:00 UTC timer.

Until those exist, the server continues with the September Supabase archives and no current Kode backup.
