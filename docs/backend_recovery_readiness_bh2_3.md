# IT's No Matata — Stage BH-2.3: Recovery Consistency and Deployment Preparation

Date: 28 October 2026. This stage changes how a backup is classified and published. It does not create a production role, bucket, encryption identity, timer, or backup. It does not contact the production host.

**Recommendation: NO-GO for the first production backup.**

The recovery rules below are implemented and passed on disposable PostgreSQL 17 and MinIO. Production is still blocked because the live MinIO size is unknown, the off-site bucket does not exist, the backup role is not on the serving database, and the age identity is not in custody.

## 1. Scripts

| File | Role |
| --- | --- |
| `deploy/backup/backup-set.sh` | Build one encrypted set and classify it |
| `deploy/backup/source-policy.sh` | Production and drill source rules |
| `deploy/backup/restore-drill.sh` | Isolated restore of a valid or degraded set |
| `deploy/backup/hold-snapshot.py` | Shared database snapshot and reference list |
| `deploy/backup/sql/kode_backup_role.sql` | Scoped role, applied only in a later window |
| `deploy/backup/apply-backup-role.sh` | Role installer. Refuses to run until that window |
| `deploy/backup/diagnose.sh` | Redacted configuration report |
| `deploy/backup/test-readiness.sh` | Disposable test suite |

## 2. Recovery classes

A committed reference is a row the application has already stored: ticket attachments, employee documents, content media, card attachments, and chat media URLs the catalog can parse. An unfinished upload is a row still in progress (`content.upload_sessions` not completed, or a media asset still uploading). Those are counted as `in_progress`. They do not make a set incomplete.

After the ciphertext exists, each committed reference is compared with this set and with the previous fully recoverable set:

| Class | Rule | Published as the latest fully recoverable set |
| --- | --- | --- |
| Valid | Every committed object is in this set and its etag did not change during the copy | Yes. `LATEST_OK` moves to this stamp |
| Degraded | A committed object is missing or was replaced, and the same cipher name is already in the previous `LATEST_OK` set | No. The set is uploaded with state `degraded` and `recovers_with` set to that previous stamp. `LATEST_OK` stays. `LATEST_DEGRADED` records the newer stamp |
| Incomplete | A committed object is missing or was replaced, and no previous fully recoverable set contains it | No. The local set is kept. It is not uploaded. Restore refuses it. Exit code 7 |

The cipher name is `sha256(bucket + newline + key) + ".age"`. The public manifest lists that name and the counts. It does not list the object key. The server can check the previous set without the age private key.

Unparsed chat URLs are counted and do not, by themselves, change the class. A failed object download, a failed encryption, an interrupted upload, or a checksum mismatch is a failed run. It does not move `LATEST_OK`.

Incomplete and failed runs keep their encrypted files and manifest. The script still removes plaintext indexes, staged config copies, and password files. It does not delete remote objects.

Restore accepts state `valid` or `degraded`. A degraded restore prints the earlier stamp it depends on. State `incomplete` is refused.

## 3. Tests

`deploy/backup/test-readiness.sh` finished with `ALL_PASS 53` on disposable PostgreSQL 17 (`127.0.0.1:54339`) and disposable MinIO (`127.0.0.1:19100` and `127.0.0.1:19210`). Those processes were removed afterward. Nothing in the suite opens the production address except as a value the scripts must reject before connecting.

| Check | Result |
| --- | --- |
| Production source authorization, check-only | Pass. Stops before a connection |
| Drill rejection of the production database, port, public host, and `postgres` user | Exit 2 |
| Encrypted backup creation | State `valid`, `LATEST_OK` updated |
| Unfinished upload | Counted as `in_progress`, set stayed valid |
| Missing object that exists in the previous set | State `degraded`, `LATEST_OK` unchanged |
| Replaced object that exists in the previous set | State `degraded`, `LATEST_OK` unchanged |
| Missing object with no previous copy | State `incomplete`, local evidence kept, not uploaded, restore refused, `LATEST_OK` unchanged |
| Failed object download | Exit 1, evidence kept, `LATEST_OK` unchanged |
| Interrupted off-site transfer and lost connection | Exit 1, local manifest kept, `LATEST_OK` unchanged |
| Remote checksum mismatch | No success manifest, `LATEST_OK` unchanged |
| Encryption and decryption, database restore, MinIO restore | Pass on the valid set, including a zero-byte object |
| Previous verified set | Survived dump failure, low space, degraded runs, and the incomplete run |
| Redacted diagnostics | Variable names only. Secret values and the private-key marker were not printed |
| Role installer without an approved window | Exit 2, password not printed |
| Restore onto a public address, port 5433, or the production MinIO URL | Exit 2 |

## 4. Remaining blockers

1. Live MinIO bytes are still unknown, so the free-space gate cannot be evaluated.
2. No off-site bucket exists. Option A is the prepared policy and has not been created.
3. `kode_backup` does not exist on the serving database.
4. The age identity has not been generated or stored offline. Only a disposable test key was used, and it must not be reused.
5. The read-only MinIO user and the separate recovery credential do not exist.
6. No isolated restore of a real production set has been done, because no production set exists.
7. Historical archives in `/var/backups/itsnomatata` are still world-readable. The `chmod` is not part of this stage.

## 5. Production prerequisites

All of these are later approvals. None were done in this stage.

1. Generate the age identity on a machine that is not the VPS. Keep two offline copies with the recovery credential. Copy only the recipient public key to `/etc/kode-backup/age.recipient`, mode `600`.
2. Create the Option A bucket described in section 6. Do not create it until that window.
3. Put the rclone remote in `/etc/kode-backup/destination.pin`, mode `600`. The pin is the remote name and path, not a secret key.
4. Create the MinIO read user for the seven buckets: `s3:GetBucketLocation`, `s3:ListBucket`, `s3:GetObject`. Confirm the policy document has no delete action before any probe.
5. Apply the backup role with `deploy/backup/apply-backup-role.sh` only when `KODE_ROLE_APPLY_CONFIRM=serving-window` and the container is `kode-vps-postgres`. The password comes from the environment, loaded from a mode `600` file.
6. Run the storage procedure in section 7. The backup must pass the free-space gate on its own; do not start it if the measurement is still blocked.
7. Run one manual set from the runbook. On another machine, restore it with `KODE_RESTORE_CONFIRM=isolated` and check application authorization against that copy.
8. Only after that restore succeeds, install the 02:00 UTC timer.

The unit must not set `AGE_IDENTITY`, `KODE_BACKUP_ALLOW_LOCAL_OFFSITE`, or `KODE_BACKUP_CHECK_ONLY`.

## 6. Secret-safe first backup

Do not put a password, MinIO key, age private key, object-storage key, JWT secret, or application secret in a command argument, shell history, or log. `deploy/backup/diagnose.sh` prints file modes, sizes, and variable names. It does not print values. A private key in the environment file is reported as `age_private_key=present_remove_it`.

Prepare `/etc/kode-backup/backup.env`, mode `600`, owner root. The file holds the names below. Values stay in that file.

```
KODE_BACKUP_MODE=production
KODE_BACKUP_ROOT=/var/backups/kode-platform
KODE_OFFSITE_DIR=/var/backups/kode-platform/staging
KODE_SOURCE_STACK=kode-platform-vps
KODE_PG_DOCKER_CONTAINER=kode-vps-postgres
PGHOST=127.0.0.1
PGPORT=5433
PGUSER=kode_backup
PGDATABASE=kode_platform_staging
PGPASSWORD=
MC_CONFIG_DIR=/etc/kode-backup/mc
AGE_RECIPIENT=
```

`AGE_RECIPIENT` is the public recipient. `AGE_IDENTITY` must not appear. MinIO and rclone secrets live in their own mode `600` config files, named by `MC_CONFIG_DIR` and the rclone config. Do not run `mc alias set` with the access key and secret on the command line. Do not run `psql -v kode_backup_password=...`. Do not run `docker exec -e PGPASSWORD=...`.

The first run is a systemd one-shot, or a root script that is not typed into an interactive shell:

```
[Service]
Type=oneshot
EnvironmentFile=/etc/kode-backup/backup.env
ExecStart=/bin/bash -c 'KODE_RCLONE_REMOTE=$(tr -d "\\n" < /etc/kode-backup/destination.pin) exec /opt/kode-platform/deploy/backup/backup-set.sh'
```

Before the run, as root and without printing the file:

```
bash /opt/kode-platform/deploy/backup/diagnose.sh
```

A valid result prints the stamp and moves `LATEST_OK`. A degraded result prints the stamp, leaves `LATEST_OK` on the previous valid set, and writes `LATEST_DEGRADED`. An incomplete result exits 7, leaves `LATEST_OK` unchanged, and keeps the local set. Do not delete that directory by hand until the missing reference is understood.

This unit was not installed. This command was not run.

## 7. Retention, Option A

Initial policy, not created in this stage:

- One bucket, created with Object Lock in Compliance mode for 14 days.
- The project contains only that bucket. Hetzner keys can see every bucket in the project.
- The backup job uploads one new set per day and never deletes. Fourteen daily sets are the retention claim. There is no monthly claim.
- The credential on the VPS can `PutObject`, `GetObject`, and `ListBucket`. It cannot delete an object or bypass a lock.
- A second credential can `GetObject` and `ListBucket`, cannot delete, and is stored offline with the age identity. The VPS does not have it. Recovery after the VPS is lost uses that credential.

Option C can be added later without rewriting a completed set. The daily bucket and its 14-day lock stay as they are. A new monthly bucket is created with a 180-day Compliance lock. A chosen set is uploaded a second time as the ciphertext it already is. Hetzner `CopyObject` stays inside one bucket, so the monthly copy is a second upload, not a server-side copy and not a new encryption. The age identity does not change. Older daily sets remain readable with that same identity. No completed object is re-encrypted or renamed.

## 8. Read-only storage measurement

Not executed. The account available over SSH, `servercontrol`, cannot run Docker (`docker` exit 1) and cannot read the MinIO volume. The earlier signed metrics request returned HTTP 403. This stage did not repeat that contact and did not list object bodies.

Same-day free space already measured on `ubuntu-8gb-fsn1-2`:

| | Bytes |
| --- | --- |
| Filesystem size | 160,921,083,904 |
| Used | 59,827,793,920 |
| Available | 94,518,353,920 |

Available space is 88.0 GiB. The gate refuses when free space minus (object bytes + object bytes / 3 + 4096 bytes per object + 5 GiB) is under 20 GiB. Object bytes are unknown, so this stage cannot say the gate would pass.

When an authorized MinIO reader exists, an operator measures listing metadata only. This does not download bodies and does not change MinIO configuration. The alias is already in a mode `700` config directory. The keys are not on the command line.

```
# NOT EXECUTED
mc du --depth 1 kode-backup-read/chat-images
mc du --depth 1 kode-backup-read/chat-attachments
mc du --depth 1 kode-backup-read/content-review-assets
mc du --depth 1 kode-backup-read/employee-documents
mc du --depth 1 kode-backup-read/kode-staging
mc du --depth 1 kode-backup-read/organization-branding
mc du --depth 1 kode-backup-read/profile-pictures
df -B1 /
```

Add the seven byte totals and the seven object counts, then apply the gate. Stop if the only available account is still `servercontrol`.

## 9. GO / NO-GO

**NO-GO for production deployment and for the first production backup.**

The classification, publication, and secret-handling behavior is ready to rehearse. Turning it on still requires the age identity, the Option A bucket, the scoped database role, the read-only MinIO user, a measured object size that passes the free-space gate, and one isolated restore of that first set.
