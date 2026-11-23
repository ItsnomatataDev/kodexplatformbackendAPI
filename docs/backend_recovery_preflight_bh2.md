# IT's No Matata — Stage BH-2: Backup Recovery Preflight

**Date:** 28 October 2026  
**Stage:** read-only planning. No backup, restore, permission change, or service restart was performed.  
**Continues from:** `docs/backend_health_architecture_audit.md` (BH-1)  
**Host inspected:** `ubuntu-8gb-fsn1-2` (`128.140.124.44`, `api.tmctechsolutions.com`)

This plan is for approval. Commands in section 8 are the proposed implementation. They are not an instruction to run them now.

---

## 1. What stopped the backups

### Confirmed

The job that wrote `/var/backups/itsnomatata` is still on disk:

| Piece | Path |
|---|---|
| Daily script | `/opt/itsnomatata-api/backup/run-backup.sh` |
| Helpers | `/opt/itsnomatata-api/backup/lib/common.sh` |
| Off-site copy | `/opt/itsnomatata-api/backup/offsite-sync.sh` |
| Verify | `/opt/itsnomatata-api/backup/verify-backup.sh` |
| Restore | `/opt/itsnomatata-api/backup/restore-backup.sh` |
| Config file | `/etc/itsnomatata/backup.env` (mode 600, root, not read) |
| Output root | `/var/backups/itsnomatata` |

The script header says it was installed by `deploy-backup-system-vps.sh`. That installer is not on the host. No crontab line is stored next to the scripts.

What the script actually backs up, from `run-backup.sh` and `common.sh`:

- Compose project directory, default `/opt/itsnomatata-api/stack` (the old Supabase stack).
- It refuses to continue unless `docker compose ps db` succeeds in that directory.
- PostgreSQL dump is `pg_dump -U postgres -Fc --blobs postgres` inside the compose service named `db`. That is the Supabase database `postgres`, not `kode_platform_staging`.
- MinIO is a hardlink `rsync` of the Docker volume whose name contains `minio-data`, into `/var/backups/itsnomatata/storage/minio-snapshots/<stamp>`.
- The small `.tar.zst` also copies `stack/.env`, Caddyfile, edge functions, LiveKit directory, and the `db-config` volume (pgsodium keys).

Last success:

| Artifact | Timestamp |
|---|---|
| Newest archive | `itsnomatata-20260922T020001Z.tar.zst` (9,724,022 bytes) |
| Manifest | same stamp, `minio_mode=hardlink-snapshot`, postgres dump about 12 MB uncompressed, MinIO tree about 7.3 GB |
| `LATEST_OK` | contents `20260922T020001Z` |
| Snapshots kept | `20260920T020001Z`, `20260921T020001Z`, `20260922T020001Z`, plus `latest` symlink |
| Earlier archives | 14 September 11:45 UTC (first run), then every day at 02:00:01 UTC through 22 September |

Nine archives, all still present. `KEEP_DAILY` defaults to 14, so pruning has not deleted them.

The same morning, after that 02:00 run, the Supabase stack was removed:

- `/opt/itsnomatata-api/SUPABASE_REMOVED.md` is dated in the file “2026-09-22” and its mtime is **2026-09-22 06:29:05 UTC**. It says Supabase containers and data were wiped after the Kode cutover, and that `stack/run.sh` and `docker compose up` must not be run. Caddy was kept for `api.tmctechsolutions.com` and `meet.itsnomatata.com`.
- `/opt/itsnomatata-api` has the same mtime.
- `/var/spool/cron/crontabs` mtime is **2026-09-22 06:29:56 UTC**, 51 seconds later.

The three PostgreSQL processes running today use these volumes:

| Volume | Role |
|---|---|
| `kode-platform-vps_kode_vps_postgres_data` | Serving database. Live connections to `kode_platform_staging` on `127.0.0.1:5433`. Up since late September (33 days at BH-1) |
| `kode-restore-pgdata` | Separate postmaster, up 19 days, no client sessions seen in BH-1 |
| `kode-cdn-migration-rehearsal-data` | Separate postmaster, up 19 days, no client sessions seen in BH-1 |

None of them is the Supabase service `db`. Live MinIO is volume `kode-platform-vps_kode_vps_minio_data`, mounted at `/data` in the MinIO process. The old script looks for a volume name containing the hyphenated string `minio-data`. The live volume uses `minio_data` (underscore), so a revived old script would not select it even if the `db` check were removed.

No systemd timer backs up this application. `systemctl list-timers --all` shows only Ubuntu timers (`dpkg-db-backup` is the package database, not Kode). `/etc/cron.d`, `/etc/cron.daily`, and `/etc/cron.hourly` have no Itsnomatata job.

### Remaining uncertainty

Root’s crontab could not be read (`/var/spool/cron/crontabs` is mode 1730). `/var/log/syslog` is group `adm`, which this account is not in. So it is not proven whether the 02:00 line was deleted at 06:29 or still fires and exits.

That does not change the outcome. There is no archive newer than 22 September. If the line still fires, `run-backup.sh` dies on `compose ps db` before it writes anything, because that service is gone. Either way, **the live Kode database has never been dumped by this job**, and the 36 days since the cutover exist only on the production disk.

`/etc/itsnomatata/backup.env` was not readable. Off-site settings live there. `offsite-sync.sh` runs only when `BACKUP_OFFSITE_ENABLED=1`, and it uploads the small `.tar.zst` and manifest only. It does not upload the MinIO snapshot tree. No rclone config or off-site copy was found in paths this account can search. Whether a remote still holds the September archives is unverified. The object bytes from September are only on this disk.

### Do not reuse the old restore script

`restore-backup.sh` stops Supabase services, runs `pg_restore --clean --if-exists` into database `postgres`, and `rsync -aH --delete` onto the live MinIO volume. Pointing it at this host would fight the wrong compose project and can delete live objects. It is not the recovery procedure for Kode.

---

## 2. Recovery assets that matter now

### Production, must be in the new backup

| Asset | Where it is | Why |
|---|---|---|
| Database `kode_platform_staging` | Serving Postgres, `127.0.0.1:5433`, volume `kode-platform-vps_kode_vps_postgres_data` | System of record. Logical size 53 MB on 28 October (BH-1). About 14.4 million commits since 21 September are not in the September dump |
| MinIO buckets | Volume `kode-platform-vps_kode_vps_minio_data`, API `127.0.0.1:9000` | Files the database points at |
| API runtime config | `/opt/kode-platform/.env.vps`, `docker-compose.vps.yml` | Required to boot a restored API. Contains secrets. Encrypt before it leaves the host |
| LiveKit config | `/opt/livekit/livekit.yaml`, `/opt/livekit/docker-compose.yml` | Calls. The yaml contains the API secret. Encrypt it |
| Caddy config | Inside the Caddy container, up 62 days. Path not readable by this account | TLS routes for the API and `meet.itsnomatata.com`. Copy it once, with Docker access, into the encrypted bundle |

Buckets present on the live MinIO, listed by name only on 28 October:

| Bucket | Product use |
|---|---|
| `chat-images` | Chat. Keep this pipeline unchanged |
| `chat-attachments` | Chat. Keep this pipeline unchanged |
| `content-review-assets` | Content Studio and media-platform originals / renditions |
| `employee-documents` | Documents and payslips |
| `kode-staging` | General application bucket (`MINIO_BUCKET` on this host) |
| `organization-branding` | Logos and branding |
| `profile-pictures` | Avatars |

Redis is not a recovery source. Sessions, messages, and files are in PostgreSQL and MinIO. BH-1 already recorded AOF on Redis; rebuilding leases and rate-limit keys is enough.

### Historical, keep, do not prune, do not treat as the current backup

| Asset | Notes |
|---|---|
| `/var/backups/itsnomatata/archives/itsnomatata-20260914T114520Z` through `20260922T020001Z` | Last copy of the Supabase database from before the wipe. The 02:00 dump on 22 September is pre-wipe. It does not contain Kode data written after the cutover |
| Matching manifests | Safe metadata. The archives themselves include `stack/.env` by script, so treat the tarballs as secret |
| MinIO snapshots `20260920`–`20260922` | 7.0 GB hardlink tree of the old volume. Not the live `kode_vps_minio_data` volume |

These directories are mode **755**. The archives are mode **644**. Any local account on the VPS can read the historical dumps. Locking that down is the first approved change in section 8. It was not done in this stage.

### Not the daily production set

| Volume | Treatment |
|---|---|
| `kode-restore-pgdata` | A restore copy. Not the database clients are using. Do not delete it. Do not point the new daily job at it. Do not assume it is disposable |
| `kode-cdn-migration-rehearsal-data` | A rehearsal copy. Same rule |

A one-time encrypted dump of those two volumes can be a separate approved preservation step before anyone later removes them. That step is not part of the daily job and is not authorized by this document alone.

---

## 3. Consistency between PostgreSQL and MinIO

Uploads and deletes will continue during the backup. The pair does not need the containers stopped.

**Database.** `pg_dump -Fc` of one database uses a single snapshot. `kode_platform_staging` will be internally consistent. Take that dump first.

**Objects.** After the dump has started, copy the seven buckets with the S3 API (`mc mirror`), not with `rsync` of the live MinIO filesystem. The old job rsynced the raw volume, which can capture a half-written `xl.meta` part. An API mirror only copies objects MinIO has already committed.

Window that remains:

| Event during the backup | Result |
|---|---|
| Object uploaded and its database row committed before `pg_dump`’s snapshot | In both copies |
| Row committed before the snapshot, object deleted before the mirror finishes | Row in the dump, object missing. This is the gap to document |
| Upload still in progress (Content Studio resumable session) | Session row may be in the dump; the finished object appears on the next day’s copy. The client can retry |
| Object written after the snapshot | Orphan in the object copy, or absent. Harmless |
| Chat message committed, then the process crashes before MinIO put completes | Same as a crash today: the row and the object can already diverge. Backup does not make that worse |

Do not use `mc mirror --remove` or `rsync --delete` against the only good copy.

Bucket versioning would keep a deleted object for the retention window and close the gap above. Turning versioning on is a MinIO configuration change. It is recommended, and it is **not** part of the first approved backup run. Decide it separately so a versioning change is not mixed into the first dump.

Hardlink the new object snapshot to the previous **Kode** snapshot only (`rsync -aH --link-dest` or `mc mirror` onto a CoW copy). Do not `--link-dest` against the September Supabase tree. The paths will not match, and a prune of that tree must stay impossible.

---

## 4. Storage, schedule, RPO, RTO

Measured on 28 October 2026:

| Item | Value |
|---|---|
| Filesystem `/` | 150 GB, 39% used |
| Available | 94,549,811,200 bytes (88 GiB) |
| Live database logical size | 53 MB (BH-1, same day) |
| September object snapshot | 7.0 GB, old volume, not a measurement of today’s MinIO |
| Today’s MinIO byte size | **Not measured.** The volume directory is not readable by this account |

A custom-format dump of a 53 MB database is tens of megabytes. The object copy dominates.

**Gate before the first real copy.** An operator in the `docker` group, or root, runs a read-only size check and stops if the number is too large for the free space rule below. No dump until that number is known.

Free-space rule for the first run:

- Required headroom = (measured MinIO bytes × 1.3) + 5 GB for the dump workspace and logs.
- Refuse to start if free space after that reservation would be under 20 GB.
- At 88 GB free, a MinIO under about 48 GB passes. Above that, the first copy goes straight off-server and does not land a second full tree on this disk.

Proposed policy for approval:

| Term | Proposal |
|---|---|
| Schedule | Daily at 02:00 UTC (04:00 Africa/Johannesburg), same quiet hour as the old job |
| RPO | 24 hours |
| RTO target | 8 hours until a drill measures it. Database restore is minutes. Object transfer sets the real number |
| Dump retention | 14 daily, 4 weekly, 6 monthly |
| Object snapshots on the VPS | 7 daily hardlink snapshots, only if the free-space rule still holds after day 1. Otherwise 2 local snapshots and the rest off-server only |
| Off-server retention | Same 14 / 4 / 6, with the bucket lifecycle owning deletion so the VPS credential cannot wipe history |
| Historical `/var/backups/itsnomatata` | Keep until a Kode restore drill has succeeded and someone confirms the Supabase-era data is no longer required. No automatic prune |

A tighter RPO (for example every 6 hours) is a later change. The database is small enough that the dump cost is low. Object-mirror duration is the unknown.

---

## 5. Off-site destination, encryption, access

No off-site destination was visible from this host. The business still has to name one. Requirements, regardless of vendor:

| Requirement | Why |
|---|---|
| Different machine and different disk from `ubuntu-8gb-fsn1-2` | The September copies died with the VPS if the disk dies |
| Same region is acceptable (Hetzner Storage Box in FSN, or an S3 bucket) | Cuts transfer time. Region is not the failure domain that matters; the disk is |
| Encryption before upload | The historical archives were plaintext and contained `stack/.env` |
| Backup credential can upload and cannot delete | A stolen VPS cron secret must not erase history |
| Lifecycle or object-lock retention of at least 14 days, managed by a second credential that is not on the VPS | Stops the host from pruning the only good copy |
| Server holds the age **public** key only | Private key stays in the operator password manager, with one offline copy |

Tooling proposal: `age` for the database dump and the config bundle, then `rclone` to the destination. `rclone crypt` is an acceptable substitute if the password is not stored only on the VPS. Do not upload the raw `pg_dump` or `.env.vps`.

PostgreSQL role for the dump: create `kode_backup` with read access to `kode_platform_staging` only, in an approved window. Until that role exists, the job would have to use `kode_staging`, which is the application role. Prefer the dedicated role so the cron secret is not the application password.

MinIO: a policy that allows `s3:GetObject`, `s3:ListBucket`, and `s3:GetBucketLocation` on the seven buckets, and nothing else. Not the root user.

Alerts:

- The systemd timer uses `OnFailure=` to send one message to an operations mailbox through the SMTP settings already on the host.
- Success writes `LATEST_OK` locally and uploads a small `latest-ok.txt` (timestamp and sha256 only) to the off-site prefix.
- Failure is: timer exit non-zero, `LATEST_OK` older than 26 hours, or sha256 mismatch.
- Until that mail path is proven, a person checks the off-site `latest-ok.txt` each weekday. The September job had no alert, which is why a 36-day gap was silent.

---

## 6. Isolated restore test

The test machine must not be `ubuntu-8gb-fsn1-2`. It must have no security-group or firewall path to `128.140.124.44` on ports 5433, 6379, 9000, 9001, or 3000. DNS for `api.tmctechsolutions.com` stays pointed at production.

Restore target:

- New empty Postgres 17, listening on `127.0.0.1` of the test machine only.
- Database name `kode_restore_drill`, never `kode_platform_staging` on the production host.
- New empty MinIO, seven empty buckets with the same names, on the test machine only.
- A guard at the top of the drill script exits if the hostname is `ubuntu-8gb-fsn1-2`, if the target IP is `128.140.124.44`, or if the target port is 5433 on that host.

Validation, without copying personal rows into a ticket or this repo:

- `pg_restore --list` succeeds and `schema_migrations` max matches the dump.
- Counts of `organizations.organizations`, `identity.users`, and `chat.messages` match counts taken on the source at dump time (numbers only).
- For one chat attachment and one Content Studio object, the key stored in the restored database answers `HEAD` on the restored MinIO. Do not download the body into the report.
- A second application user, who is not a member of that conversation, is not granted a URL. That check runs against an API pointed at the drill, not at production.
- Record the wall time. That measured time replaces the 8-hour RTO target if it differs.
- Destroy the drill VM or the drill containers. Do not attach them to the production Docker network.

`restore-backup.sh` is not used.

---

## 7. Read-only work already done

Completed in this stage, with no writes:

- Located the scripts and read them.
- Matched archives, manifests, `LATEST_OK`, and snapshot directory names to 22 September 2026 02:00 UTC.
- Read `SUPABASE_REMOVED.md` and the matching directory mtimes.
- Listed timers and system cron directories.
- Mapped the three Postgres volumes and the live MinIO volume from process mount tables.
- Listed the seven live bucket names.
- Recorded archive modes (644) and directory modes (755).
- Confirmed current free space.
- Confirmed `backup.env` exists and is unreadable here, and that off-site sync as written does not upload the object snapshot.

Not done, because they need root or Docker and were not required to write this plan:

- Reading root’s crontab and syslog to see whether 02:00 still fires and fails.
- Reading `backup.env` to see whether an off-site target was ever set.
- `du` of the live MinIO volume.
- Copying the live Caddyfile out of its container.
- Any checksum of the September archives (`zstd -t` is read-only and safe; it was left for the approval step so a long read of 7 GB was not started during planning).

---

## 8. Proposed commands and preconditions

Every write below needs an explicit approval after this document. The host column is the machine that runs the command.

### Step 0 — Lock the historical tree

**Host:** `ubuntu-8gb-fsn1-2` as root.  
**Writes:** permission bits only. No deletion.

Preconditions:

- `find /var/backups/itsnomatata -maxdepth 3 -printf '%y %p\n'` still shows the nine archives and three snapshot directories.
- The command is `chmod`, not `rm`.

```sh
chmod 700 /var/backups/itsnomatata
chmod -R go-rwx /var/backups/itsnomatata
```

Rollback: `chmod 755` on the directories and `chmod 644` on the archives. Only do that if a specific local account must read them, and do not leave them world-readable.

### Step 1 — Measure, still read-only

**Host:** `ubuntu-8gb-fsn1-2` as root.

```sh
du -sb /var/lib/docker/volumes/kode-platform-vps_kode_vps_minio_data/_data
df -B1 /
docker ps --filter name=kode-vps-postgres --filter name=kode-vps-minio --format '{{.Names}} {{.Status}}'
```

Stop if MinIO bytes × 1.3 + 5 GB would leave less than 20 GB free. Also copy the live Caddyfile out with `docker cp` into a root-only directory that step 3 will encrypt. That copy is a write of a config file; include it only in this same approval.

### Step 2 — Create the backup identity

**Host:** production Postgres and production MinIO. This is the only production data-plane change in the plan, and it is still a separate approval.

Preconditions:

- A fresh step 0 has been done so historical dumps are not world-readable while you add credentials.
- The new role is not a superuser.
- The MinIO policy does not include `DeleteObject`, `PutObject`, or `s3:*`.

```sh
# PostgreSQL, on the serving instance only (127.0.0.1:5433)
psql -h 127.0.0.1 -p 5433 -U kode_staging -d kode_platform_staging -c \
  "CREATE ROLE kode_backup WITH LOGIN PASSWORD :'pw';"
psql -h 127.0.0.1 -p 5433 -U kode_staging -d kode_platform_staging -c \
  "GRANT CONNECT ON DATABASE kode_platform_staging TO kode_backup;"
# Then GRANT SELECT on all current and future tables in the application schemas
# to kode_backup. Do not grant it on the other two PostgreSQL instances.
```

Store the password in `/etc/kode-backup/backup.env` mode 600, root. Do not commit it. Create the MinIO user `kode-backup-read` in the MinIO console or `mc admin user add`, attach the read-only policy for the seven buckets, and put that key in the same file.

Rollback: `DROP ROLE kode_backup` and remove the MinIO user. Application traffic uses `kode_staging` and the MinIO root credentials, so dropping the backup identity does not affect the API.

### Step 3 — First Kode backup

**Host:** `ubuntu-8gb-fsn1-2` as root.  
**Writes:** new directory `/var/backups/kode-platform` only. Does not touch `/var/backups/itsnomatata` except for the chmod in step 0.

Preconditions:

- Step 1 size gate passed.
- Destination directory does not already contain a dump from a failed partial run; if it does, move that partial run aside, do not delete it until the new run verifies.
- `docker ps` shows `kode-vps-postgres` and `kode-vps-minio` running.
- Hostname is `ubuntu-8gb-fsn1-2`.
- Disk free still satisfies the rule.
- The age public key file exists and the private key does **not** exist on this host.

```sh
set -euo pipefail
test "$(hostname)" = "ubuntu-8gb-fsn1-2"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT=/var/backups/kode-platform
WORK="$ROOT/work/$STAMP"
install -d -m 700 "$WORK/postgres" "$WORK/config" "$ROOT/archives" "$ROOT/minio/$STAMP"

# Consistent database snapshot. Custom format. No owner, so the drill can restore as another role.
docker exec kode-vps-postgres pg_dump \
  -U kode_backup -d kode_platform_staging -Fc --no-owner \
  > "$WORK/postgres/kode_platform_staging.dump"

# Objects after the snapshot has been taken. No --remove.
# MC_HOST_kode is set from /etc/kode-backup/backup.env in the real unit, not inline here.
mc mirror --overwrite=false kode/chat-images            "$ROOT/minio/$STAMP/chat-images"
mc mirror --overwrite=false kode/chat-attachments      "$ROOT/minio/$STAMP/chat-attachments"
mc mirror --overwrite=false kode/content-review-assets "$ROOT/minio/$STAMP/content-review-assets"
mc mirror --overwrite=false kode/employee-documents    "$ROOT/minio/$STAMP/employee-documents"
mc mirror --overwrite=false kode/kode-staging          "$ROOT/minio/$STAMP/kode-staging"
mc mirror --overwrite=false kode/organization-branding "$ROOT/minio/$STAMP/organization-branding"
mc mirror --overwrite=false kode/profile-pictures      "$ROOT/minio/$STAMP/profile-pictures"

# Config bundle. Root-only source files. Encrypted before the directory is archived.
install -d -m 700 "$WORK/config"
cp /opt/kode-platform/docker-compose.vps.yml "$WORK/config/"
cp /opt/kode-platform/.env.vps "$WORK/config/env.vps"
cp /opt/livekit/livekit.yaml "$WORK/config/livekit.yaml"
cp /opt/livekit/docker-compose.yml "$WORK/config/livekit-compose.yml"
# Caddyfile from the step 1 docker cp, if it was taken.

tar -C "$WORK" -cf - . | zstd -T0 -19 -c > "$ROOT/archives/kode-$STAMP.tar.zst"
sha256sum "$ROOT/archives/kode-$STAMP.tar.zst" > "$ROOT/archives/kode-$STAMP.tar.zst.sha256"
age -r "$AGE_RECIPIENT" -o "$ROOT/archives/kode-$STAMP.tar.zst.age" \
  "$ROOT/archives/kode-$STAMP.tar.zst"
rm -f "$ROOT/archives/kode-$STAMP.tar.zst"
printf '%s\n' "$STAMP" > "$ROOT/LATEST_OK"
rm -rf "$WORK"
```

From the second day on, add `--link-dest` from the previous `$ROOT/minio/<previous>` if local snapshots are kept, or skip the local object tree and mirror straight to the off-site disk when step 1 said the VPS cannot hold a second copy.

Rollback of a bad first run: delete only `$ROOT/work/$STAMP` and the partial archive under `$ROOT/archives` for that stamp. Do not delete `$ROOT/minio` objects that `mc mirror` already wrote until you have confirmed they are incomplete and you still have production. Production containers are untouched, so application rollback is “disable the timer.”

### Step 4 — Off-site copy

**Host:** `ubuntu-8gb-fsn1-2`, after step 3’s sha256 file exists.

```sh
rclone copy "$ROOT/archives/kode-$STAMP.tar.zst.age" "$RCLONE_REMOTE/archives/" \
  --checksum --immutable
rclone copy "$ROOT/archives/kode-$STAMP.tar.zst.sha256" "$RCLONE_REMOTE/archives/"
# Object tree: either the local snapshot or a direct mc mirror to the remote.
rclone copy "$ROOT/minio/$STAMP" "$RCLONE_REMOTE/minio/$STAMP/" --checksum
printf '%s\n' "$STAMP" | rclone rcat "$RCLONE_REMOTE/latest-ok.txt"
```

Preconditions: remote name is the approved destination; `rclone config` for that remote has no delete scope; a test upload of a 1-byte file to a `probe/` prefix succeeded and was listed from another machine.

Rollback: leave the remote objects. Deleting them requires the retention credential, not the VPS credential.

### Step 5 — Timer and alert

**Host:** `ubuntu-8gb-fsn1-2`.

A systemd timer at 02:00 UTC runs steps 3 and 4. `OnFailure=` runs a one-shot mail script. The unit’s `WorkingDirectory` is `/var/backups/kode-platform`. It does not call `run-backup.sh` or `restore-backup.sh`.

Rollback: `systemctl disable --now kode-backup.timer`. Existing archives stay.

### Step 6 — Drill

**Host:** a new VM or a workstation that is not the production VPS. See section 6.

```sh
test "$(hostname)" != "ubuntu-8gb-fsn1-2"
test "$PGHOST" != "128.140.124.44"
age -d -i "$AGE_IDENTITY" kode-STAMP.tar.zst.age | zstd -d | tar -x -C /tmp/kode-drill
# pg_restore into kode_restore_drill on 127.0.0.1 of THIS machine
# mc mirror from the downloaded object tree into THIS machine's MinIO
```

Rollback: destroy the drill containers and `/tmp/kode-drill`. Nothing on production changes.

---

## 9. Monitoring after the job exists

| Check | Where | Alert when |
|---|---|---|
| Timer last result | systemd | Non-zero exit |
| `LATEST_OK` age | VPS and off-site `latest-ok.txt` | Older than 26 hours |
| sha256 | Archive next to `.sha256` | Mismatch |
| Free space | `df` at the start of the job | Below the step 1 rule |
| Drill | Calendar, quarterly | No successful drill in 90 days |

Do not add a backup endpoint to the API. Do not point `/health/ready` at the backup disk. Readiness stays a database ping.

---

## 10. Risks

| Risk | What limits it |
|---|---|
| Running `restore-backup.sh` on this host | Do not use it. Guard the drill on hostname and target IP |
| First object copy fills the disk | Step 1 gate. Refuse under 20 GB free after the reservation |
| Dump and objects diverge by deletes during the mirror | Documented gap. Versioning is a follow-up decision, not a silent default |
| Cron secret is the application password | Step 2 dedicated role and read-only MinIO user |
| VPS credential deletes the off-site copy | Upload-only credential. Retention uses a different credential |
| September archives stay world-readable until step 0 | Step 0 is the first change, before new secrets are written |
| Extra Postgres volumes get deleted as “unused” | They are named in section 2 and are out of scope for cleanup |
| Old script revived and pointed at Kode by mistake | New unit has a new path and does not call `run-backup.sh`. Leave the old script in place so the historical procedure stays readable, and do not re-enable its cron |
| Chat media path gets migrated as part of backup | Mirror reads objects. It does not change buckets, keys, or the API |
| `0066`–`0068` schema drift | A dump captures the database as it is (migrations through `0065`). Do not apply migrations as part of backup |

---

## 11. Approval needed before any write

1. Step 0 chmod on `/var/backups/itsnomatata`.
2. The off-site vendor and bucket or Storage Box name.
3. Who holds the age private key.
4. The operations mailbox for failure mail.
5. RPO 24 hours, RTO target 8 hours until measured, retention 14 daily / 4 weekly / 6 monthly.
6. Creation of `kode_backup` and the read-only MinIO user.
7. Permission for the first dump and mirror into `/var/backups/kode-platform` after the size gate.
8. A date for the isolated drill, on a machine that cannot reach production Postgres or MinIO.

Until those are approved, production backup and restore stay unrun.
