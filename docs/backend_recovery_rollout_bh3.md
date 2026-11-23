# IT's No Matata — Stage BH-3: Controlled Backup Rollout Preflight

Date: 28 October 2026. The backup design and the disposable tests are accepted. This stage prepares the first real backup as separate approvals. No production write was performed.

**Do not run the eight operations below as one script. Each one needs its own approval.**

## 1. Read-only storage measurement

Host: `ubuntu-8gb-fsn1-2` (`128.140.124.44`).

What this account could run today, as `servercontrol`, with no writes:

| Check | Result |
| --- | --- |
| `df -B1 /` | Filesystem 160,921,083,904 bytes. Used 59,835,179,008. Available 94,510,968,832 (88.0 GiB). 39% on `/dev/sda1` |
| `docker ps` | Permission denied on `/var/run/docker.sock`. Exit 1 |
| Live volume directories | Not visible to this account |
| `/var/backups/itsnomatata` | Directory is visible. It was not measured. It is the historical Supabase tree, not current MinIO |

The free-space gate cannot be evaluated. Object bytes are still unknown. With 94,510,968,832 bytes free, the gate needs `plain_bytes + plain_bytes / 3 + object_count * 4096 + 5 GiB` to leave at least 20 GiB. That answer waits on the root measurement below.

`deploy/backup/measure-storage.sh` is the measurement command. It refuses to run unless `KODE_MEASURE_CONFIRM=read-only`, refuses to run off `ubuntu-8gb-fsn1-2`, and refuses any path containing `itsnomatata`, `kode-restore-pgdata`, or `kode-cdn-migration-rehearsal`. A local guard check printed `measure_guards_ok`. The script was not run on the server. Running it on this workstation exits 2.

Root runs only this, after approval. It uses `du` and `find` on directory metadata, and one `SELECT pg_database_size`. It does not read object bodies, print a password, or change a container.

```sh
# NOT EXECUTED. Root on ubuntu-8gb-fsn1-2.
KODE_MEASURE_CONFIRM=read-only bash deploy/backup/measure-storage.sh
```

The script measures only these names:

| Target | Name |
| --- | --- |
| Postgres container | `kode-vps-postgres` |
| Postgres volume | `kode-platform-vps_kode_vps_postgres_data` |
| Database | `kode_platform_staging`, local socket user `kode_staging` |
| MinIO container | `kode-vps-minio` |
| MinIO volume | `kode-platform-vps_kode_vps_minio_data` |
| Bucket directories | `chat-images`, `chat-attachments`, `content-review-assets`, `employee-documents`, `kode-staging`, `organization-branding`, `profile-pictures` |

It does not measure `/var/backups/itsnomatata`, `kode-restore-pgdata`, or `kode-cdn-migration-rehearsal-data`.

Stop if the script reports a missing bucket directory, an unexpected mount path, or `free_space_gate fail`. A pass is `free_space_gate pass` from this script. Bucket directory size is an upper bound: it includes MinIO metadata files. That makes the gate stricter than the backup's own object listing. `xl_meta` is an object-count estimate for the 4 KiB overhead term.

Expected output is one filesystem table, one Postgres database byte count, seven `bucket` lines, `staging_need_bytes`, and either `free_space_gate pass` or `free_space_gate fail`.

## 2. Recovery guarantees

| Class | What is guaranteed | What is not guaranteed |
| --- | --- | --- |
| Valid | Every committed object was copied into this set, and its etag did not change during the copy. `LATEST_OK` may move here | An unfinished upload is only counted. It is not a committed object |
| Degraded | Each missing or replaced committed object has ciphertext under the same key in the previous `LATEST_OK` set. The database dump in this set is intact | The older ciphertext is a previous version of that key. It is not proof that those bytes are the version the database snapshot expects |
| Incomplete | The local evidence is kept and `LATEST_OK` stays on the last valid set | The set is not a recovery point. Restore refuses it |

A degraded restore now has its own gate. `restore-drill.sh` will not copy a degraded set unless `KODE_RESTORE_DEGRADED_CONFIRM=content-version-unproven`. With that flag it restores bytes onto the isolated target and exits 8 with `degraded_bytes_restored_not_operational`. Exit 8 is not operational acceptance.

Before anyone accepts that restore, the reviewer has to do all of the following on the isolated copy:

1. Decrypt `consistency.ndjson.age` and list every missing or replaced key.
2. For each key, decide whether the previous set's bytes are the version the restored database row needs. The matching cipher name only shows that some earlier bytes exist.
3. Open the affected chat media, documents, and attachments through the application on that isolated copy.
4. Record the review outside the backup script. The script has no flag that turns a degraded restore into an operational success.

A valid set still exits 0 after the byte restore. Operational acceptance of that copy is still the separate application check in operation 7. Disposable tests, including this gate, finished with `ALL_PASS 55`.

## 3. Approval boundaries

Run these in order. Stop at the first stop condition. Do not start the next operation in the same change.

### Operation 1 — Historical backup permission hardening

- Host: `ubuntu-8gb-fsn1-2`, root.
- Privileges: root on `/var/backups/itsnomatata` only.
- Preconditions: `find /var/backups/itsnomatata -maxdepth 3 -printf '%y %p\n'` still shows the existing archives and snapshot directories. No process has that path mounted. The Caddy directory `/opt/itsnomatata-api/stack/volumes/proxy/caddy` is not part of this command.
- Command, not executed:

```sh
chmod 700 /var/backups/itsnomatata
chmod -R go-rwx /var/backups/itsnomatata
```

- Impact: local accounts other than root lose read access to the old archives. The live API, database, and MinIO are untouched.
- Expected output: both commands exit 0. `find` afterward shows directories `700` and archives `600`.
- Stop if the path is anything except `/var/backups/itsnomatata`, or if the command would be `rm`.
- Rollback: `chmod 755` on the directories and `chmod 644` on the archives, only if a named local account must read them. Do not leave the tree world-readable.

### Operation 2 — Age key generation and offline custody

- Host: a workstation that is not `ubuntu-8gb-fsn1-2`. The private key is never copied to the VPS.
- Privileges: the operator's own account on that workstation. Root on the VPS only for the public-key install.
- Preconditions: `age` is available on the workstation. Two offline stores are chosen before the key exists. The disposable test key is not reused.
- Commands, not executed:

```sh
# On the workstation. The identity file stays there.
age-keygen -o kode-backup-identity.txt
# Public line only, then install that line on the VPS:
install -m 600 /dev/stdin /etc/kode-backup/age.recipient
```

- Impact: none on the running services. The VPS receives one public recipient line.
- Expected output: `age-keygen` prints one `age1...` recipient. The identity file starts with `AGE-SECRET-KEY-` and is not on the server. `diagnose.sh` on the server reports the recipient file present and `age_private_key=absent`.
- Stop if the identity file is about to be copied to the VPS, or if `diagnose.sh` reports `age_private_key=present_remove_it`.
- Rollback: remove `/etc/kode-backup/age.recipient`. Keep the private key in both offline stores until a replacement key has been proven. Deleting the only copies makes every later set unreadable.

### Operation 3 — Off-site destination, Option A

- Host: the Hetzner project console, by an account allowed to create a bucket. Then root on `ubuntu-8gb-fsn1-2` for the pin and the upload config file.
- Privileges: project admin for bucket creation. Root on the VPS for `/etc/kode-backup`. The VPS upload key must not be the project admin key.
- Preconditions: operation 2 is done. The project contains no other buckets. Object Lock is selected at creation. Compliance retention is 14 days. The bucket is private. No monthly retention is claimed.
- Actions, not executed:
  1. Create one bucket with Object Lock and a 14-day Compliance default retention.
  2. Create an upload key that can `ListBucket`, `GetBucketLocation`, `GetObject`, and `PutObject`. It cannot `DeleteObject`, `DeleteObjectVersion`, or bypass a lock.
  3. Create a recovery key that can `ListBucket`, `GetBucketLocation`, and `GetObject`. It cannot delete. Store it with the age identity. Do not place it on the VPS.
  4. From a workstation, put a one-byte probe and confirm the upload key cannot delete it. Leave the probe until retention expires.
  5. On the VPS, write the rclone remote name and bucket path, with no secret, to `/etc/kode-backup/destination.pin`, mode `600`. Put the upload secret in the rclone config, mode `600`, not on a command line.
- Impact: a new empty bucket and two keys. No application data moves.
- Expected output: the probe is listed, the delete attempt fails, and the pin file matches the remote the backup will use.
- Stop if Object Lock was not set at creation, if the project has any other bucket, if the upload key can delete the probe, or if the destination contains `128.140.124.44`, `api.tmctechsolutions.com`, or `meet.itsnomatata.com`.
- Rollback: disable the unused keys. The locked probe remains until its retention date. Do not point the backup at a bucket whose lock was omitted. Later, Option C is a second bucket and a second upload of an existing ciphertext set. It does not rewrite sets already stored here.

### Operation 4 — Scoped PostgreSQL backup role

- Host: `ubuntu-8gb-fsn1-2`, root, container `kode-vps-postgres` only.
- Privileges: database user `kode_staging` inside that container. The password is loaded from a mode `600` file into the environment. It is not a `psql -v` argument.
- Preconditions: operations 1 through 3 are done. `pg_database_size` from section 1 is recorded. The role does not already exist. The two rehearsal Postgres volumes are not the target.
- Command, not executed:

```sh
KODE_ROLE_APPLY_CONFIRM=serving-window \
KODE_PG_DOCKER_CONTAINER=kode-vps-postgres \
KODE_BACKUP_PASSWORD="$(cat /etc/kode-backup/kode-backup-password)" \
  bash deploy/backup/apply-backup-role.sh
```

The password file is mode `600`. Prefer a root shell that does not record history, or a systemd one-shot with `EnvironmentFile=`, so the value does not land in shell history. Without `KODE_ROLE_APPLY_CONFIRM=serving-window` the script exits 2. That refusal was tested.

- Impact: one new login with `SELECT` on `kode_platform_staging`. It is not a superuser and cannot read `pg_authid`. Application sessions stay on `kode_staging`.
- Expected output: `backup role applied`. A follow-up `SELECT rolpassword FROM pg_authid` as `kode_backup` returns permission denied.
- Stop if the container is not `kode-vps-postgres`, if the port is not `5433`, or if the role can read another database.
- Rollback: `DROP ROLE kode_backup` on that same database. Do not drop `kode_staging`.

### Operation 5 — Read-only MinIO identity

- Host: `ubuntu-8gb-fsn1-2`, root, container `kode-vps-minio`.
- Privileges: the existing MinIO admin, taken from the admin config file. Do not pass the access key or secret on the command line.
- Preconditions: the seven bucket names in section 1 exist. The policy document is reviewed before it is attached. The policy allows `s3:GetBucketLocation`, `s3:ListBucket`, and `s3:GetObject` on those buckets and has no write or delete action.
- Actions, not executed: create user `kode-backup-read`, attach that policy, and store its keys in `/etc/kode-backup/mc`, mode `700`. Confirm a write and a delete are denied before any backup. Do not use a delete against a live object as the test if the policy might be wrong. Review the policy text first, then probe with a disposable object created for the probe and removed by the admin key.
- Impact: one new MinIO user. Application credentials stay as they are.
- Expected output: `mc ls` succeeds for the seven buckets. `mc pipe` and `mc rm` as this user fail.
- Stop if the policy contains `s3:DeleteObject`, `s3:PutObject`, or `s3:*`.
- Rollback: `mc admin user remove` for `kode-backup-read` with the admin config. Live objects stay.

### Operation 6 — First encrypted production backup

- Host: `ubuntu-8gb-fsn1-2`, root.
- Privileges: root, the `kode_backup` role, and the MinIO read user. Environment comes from `/etc/kode-backup/backup.env`, mode `600`.
- Preconditions: section 1 reported `free_space_gate pass`. Operations 2 through 5 are done. `diagnose.sh` shows no private key. `AGE_IDENTITY` is unset. The pin matches the remote. No timer is installed yet.
- Command, not executed: the systemd one-shot in `docs/backend_recovery_readiness_bh2_3.md` section 6, using `EnvironmentFile=/etc/kode-backup/backup.env`.
- Impact: read load on Postgres and MinIO, one `zstd` thread at `nice -n 19`, and an upload capped at 8 MiB/s. New files appear under `/var/backups/kode-platform` and in the off-site bucket. Live objects, the database, containers, Caddy, and the historical tree are not modified.
- Expected output: one stamp, manifest state `valid`, and `LATEST_OK` equal to that stamp. A `degraded` result must not be treated as the first good backup. An incomplete result exits 7 and leaves `LATEST_OK` absent.
- Stop if the gate would fail, if the manifest is not `valid`, if diagnostics print a secret, or if the run tries to replace an existing stamp.
- Rollback: leave the uploaded ciphertext. Do not delete it. A failed run keeps local evidence and does not publish `LATEST_OK`. Removing `/etc/kode-backup/backup.env` stops another manual run.

### Operation 7 — Isolated restoration and validation

- Host: a machine that is not `ubuntu-8gb-fsn1-2`, with its own Postgres 17 and MinIO on loopback.
- Privileges: the offline age identity and the offline recovery key. The production host, port `5433`, database `kode_platform_staging`, and the production MinIO address are refused.
- Preconditions: operation 6 produced a `valid` set. `KODE_RESTORE_CONFIRM=isolated`. The target database is empty and is not one of the production names.
- Command, not executed: `deploy/backup/restore-drill.sh` against that isolated target. Then start the application against the copy and check chat authorization.
- Impact: none on the VPS. The isolated machine receives the database and the seven buckets.
- Expected output: exit 0 and `valid_restore_bytes_ready`, then a passed application authorization check. A degraded set exits 8 and stays not operational until the review in section 2 is written down.
- Stop if the target host, port, database, user, or MinIO URL is a production value, or if the manifest state is `incomplete`.
- Rollback: discard the isolated copy. The off-site set stays.

### Operation 8 — Daily scheduling and failure alerting

- Host: `ubuntu-8gb-fsn1-2`, root.
- Privileges: root, to install a systemd timer. The service uses the same `EnvironmentFile` as operation 6.
- Preconditions: operation 7 passed on a `valid` set. The timer does not exist yet.
- Unit, not installed: a oneshot service running `backup-set.sh` at 02:00 UTC, and a timer. `AGE_IDENTITY` stays unset. A second check, also not installed, alerts when `LATEST_OK` is older than 26 hours or the service result is non-zero. The alert text contains the stamp and the exit code, not a secret.
- Impact: the same read and upload load as operation 6, once per day.
- Expected output: the next morning `LATEST_OK` is newer than 26 hours and the service result is 0. A degraded or incomplete run alerts and does not replace `LATEST_OK`.
- Stop if operation 7 has not passed, or if the unit file contains a password, a private key, or `AGE_IDENTITY`.
- Rollback: `systemctl disable --now` on the timer and the alert timer. Sets already uploaded stay until retention expires.

## 4. Production safety verification

Reviewed `backup-set.sh`, `restore-drill.sh`, `source-policy.sh`, `apply-backup-role.sh`, `hold-snapshot.py`, and `measure-storage.sh`. None of these commands were run against production.

| Forbidden outcome | What blocks it |
| --- | --- |
| Restore over production | `restore-drill.sh` refuses hostname `ubuntu-8gb-fsn1-2`, a non-loopback database, port `5433`, database `kode_platform_staging`, users `postgres`, `kode_staging`, and `kode_backup`, and a MinIO URL that is not loopback. It requires `KODE_RESTORE_CONFIRM=isolated` |
| Remove live MinIO objects | `backup-set.sh` has no `mc rm`, `mc rb`, or `mc mirror`. The intended MinIO user has no delete action. The script's static test fails if a delete command is added |
| Modify production PostgreSQL data | The backup opens a read-only repeatable-read snapshot and runs `pg_dump`. The role SQL grants `SELECT` only. `apply-backup-role.sh` exits 2 until `KODE_ROLE_APPLY_CONFIRM=serving-window` |
| Restart production containers | No backup script calls `docker restart`, `docker stop`, `docker rm`, or `docker compose` |
| Apply migrations | No backup script invokes the migration runner |
| Change public API routing | No backup script writes Caddy config or the API listen address. Operation 1 does not touch `/opt/itsnomatata-api` |
| Delete historical Supabase backups | `source-policy.sh` refuses a backup root under `/var/backups/itsnomatata` or `/opt/itsnomatata-api`. Operation 1 is `chmod` only, and only after its own approval |
| Remove the rehearsal Postgres volumes | No script names `kode-restore-pgdata` or `kode-cdn-migration-rehearsal-data` except `measure-storage.sh`, which refuses to measure them |

`backup-set.sh` removes plaintext passwords and, after a verified off-site upload, its own local staging. It does not delete remote objects or an incomplete set.

## 5. Decision

**NO-GO for every production write in this stage.**

The next authorized action, when separately approved, is the root measurement in section 1. The eight operations stay closed until that measurement reports `free_space_gate pass` and each preceding operation has its own approval.
