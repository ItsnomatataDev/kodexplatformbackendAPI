# IT's No Matata — Stage BH-2.1: Corrected Backup and Recovery Design

Date: 28 October 2026. This stage accepts the BH-2 finding that the old job targets the removed Supabase deployment. It does not approve the BH-2 commands. Nothing in this stage was executed on `ubuntu-8gb-fsn1-2` or against `128.140.124.44`. No production backup, restore, role, permission change, or restart was performed.

The scripts for a later review are `deploy/backup/backup-set.sh`, `deploy/backup/restore-drill.sh`, and `deploy/backup/sql/kode_backup_role.sql`. They refuse the production hostname, the production database address, and the production Postgres port.

## 1. BH-2 issues discovered

The BH-2 procedure cannot be used as written.

- Age encryption covered the small database and config archive only. The seven MinIO buckets were copied with `rclone copy` as plaintext.
- `LATEST_OK` was written after the local archive and before the off-site copy. A failed transfer would still look like success. The off-site `latest-ok.txt` had the same problem.
- `sha256sum` hashed `kode-$STAMP.tar.zst`, and the next command deleted that file. The retained file was the `.age` object, which had no checksum of its own.
- The `pg_dump | zstd | age` pipeline needs `set -o pipefail`. Without it, a failed `pg_dump` still produced exit 0. On the disposable instance that path wrote a truncated archive, `age` succeeded, and `pg_restore` later stopped at EOF.
- `CREATE ROLE` plus `GRANT CONNECT` cannot dump the database. A role with only `CONNECT` failed with `permission denied for schema work`.
- `pg_read_all_data` is the privilege that works, and it does not cover large objects. `pg_dump` 17 includes large objects unless `--no-large-objects` is set. A dump of a database that contained one large object failed for `kode_backup`.
- `mc mirror --overwrite=false` is not the documented MinIO Client spelling. `--overwrite` is a boolean switch. On `mc` RELEASE.2025-08-13, `--overwrite=false` against an existing object exited 0 and left the old bytes, but that spelling is not a contract. The default mirror already refuses overwrite (`mm-source-mtime`). `--remove` deletes extra objects on the destination.
- `zstd -T0 -19` uses every core at the highest level on the 4-vCPU host that also runs the API and LiveKit.
- `restore-backup.sh` runs `pg_restore --clean` and `rsync --delete`. It must not be used.
- The object copy was a second plaintext tree. There was no design for where the decryption key lives, or for what happens when that key is lost.
- Hetzner Storage Box was named as an acceptable destination. Its snapshots are customer-managed. They are not object-lock immutability.

## 2. Corrected backup architecture

One backup set is one directory, `sets/<stamp>/`, created once and never replaced. The stamp is UTC `YYYYMMDDTHHMMSSZ`. A second run with the same stamp exits 2.

Every retained byte is age ciphertext encrypted to a recipient public key:

- `postgres.dump.zst.age` — `pg_dump -Fc --no-owner --no-privileges --no-large-objects`, streamed through `zstd -3 -T1`, then `age`.
- `config.tar.zst.age` — deployment files copied by basename, then the same stream. The tested file was a disposable env file.
- `objects/<sha256>.age` — one ciphertext per object. The file name is the SHA-256 of `bucket + key`, so the public name is not the object key.
- `index.ndjson.age` — the only map from cipher name back to bucket and key. It is encrypted. The plaintext index is removed before publication.
- `manifest.public.json` — recovery set id, state, per-bucket object counts and byte sizes, and the cipher file name, size, and SHA-256. It has no object keys, filenames, passwords, or age identity.

`rclone` is transport. It copies ciphertext. It is not the encryption layer.

The job runs at 02:00 UTC. Bounds are `nice -n 19`, `zstd -3 -T1`, one object at a time, and `rclone` with `--transfers 1 --bwlimit 8M`.

States, in order:

1. `started`
2. `local_snapshot_completed` — the database stream has finished.
3. `encryption_completed` — dump, config, objects, and the encrypted index exist locally.
4. `offsite_transfer_completed` — ciphertext is in the set directory and the public manifest is written, still not `complete`.
5. `integrity_verified` — every retained cipher file matches its SHA-256, and the remote check has matched.
6. `complete` — the manifest says `complete` and `LATEST_OK` is replaced.
7. `failed` — the run directory records failure. `LATEST_OK` is not touched.

`LATEST_OK` is written by creating a temporary file and renaming it, and only after integrity verification. A newer failed run leaves the previous stamp in place. The daily completion check reads that marker and the timer exit code. A restore drill writes its own record. It does not update `LATEST_OK`.

When a remote is configured, ciphertext is uploaded first, with the manifest excluded. `rclone check --download --one-way` streams the remote bytes back and compares them. The manifest is marked `complete` and uploaded only after that check. Local staging ciphertext is then deleted. The remote set is the retained copy.

`KODE_BACKUP_ALLOW_LOCAL_OFFSITE=1` exists for the disposable test, where the set directory itself is the destination. The production unit must set `KODE_RCLONE_REMOTE`. Without a remote, and without that test flag, the script exits 2.

The backup script exits 2 if `AGE_IDENTITY` is set. The VPS job has the public key only.

## 3. Encryption and key recovery

### age

The VPS holds the recipient public key. Encryption needs only that key. Decryption needs the identity file, which stays off the VPS: one copy in the operator password manager and one offline copy in a second place. The backup script refuses to run if an identity is present in the environment.

A compromise of the VPS exposes live Postgres and live MinIO. It does not expose the ability to decrypt backups already stored off the server. An attacker who also steals the upload credential can write new ciphertext. Compliance retention, below, is what stops them deleting the older sets.

Key loss of both identity copies makes every encrypted set unreadable. The live VPS is unaffected until the VPS itself is lost. There is no escrow on the server, because that escrow would defeat the separation.

Key compromise of the identity decrypts every set still inside the retention window. Rotation means a new recipient for new sets. Old sets remain readable only with the old identity, which is kept until those sets expire. Re-encrypting history is a full copy and is a separate job.

The daily job cannot decrypt. Its integrity check is the SHA-256 of the ciphertext it uploaded, confirmed by a streamed download. Decryption is proved only on the isolated drill.

### rclone crypt

`rclone crypt` encrypts file names and contents, but the password has to be available wherever encryption happens. On this design that is the VPS. Anyone who can read the VPS rclone config can decrypt the off-site copies. Putting the password only on a laptop means the VPS cannot encrypt. Splitting the password across both machines puts a decryption secret back on the VPS.

`rclone crypt` is a reasonable transport for a machine that is already allowed to decrypt. It is the wrong primary design for a server that must keep producing backups after the operators have gone home, without holding the decryption key.

### Recommendation

Use age for every artifact. Use rclone only to move ciphertext. One scheme covers Postgres, configuration, and all seven buckets, and the decryption key is not on the server that is being backed up.

## 4. Scripts for later review

`deploy/backup/backup-set.sh` implements the set, the state machine, the age streams, the public manifest, the remote check, and the `LATEST_OK` publication. It refuses:

- hostname `ubuntu-8gb-fsn1-2`
- `PGHOST` of `128.140.124.44` or `api.tmctechsolutions.com`
- port `5433` together with database `kode_platform_staging`
- an age identity in the environment
- a local directory presented as off-site storage
- replacement of an existing set id
- a database whose `pg_largeobject_metadata` count is not zero

`deploy/backup/restore-drill.sh` restores one complete set onto a caller-supplied database and MinIO alias. It refuses the production host, the production address, port `5433`, the database name `kode_platform_staging`, a MinIO alias named `kode`, `kode-vps`, `production`, or `prod`, and any manifest whose state is not `complete`. It has no production write credentials in the script.

`deploy/backup/sql/kode_backup_role.sql` is the proposed role. It was not applied to production. The disposable test created the equivalent role on `kode_drill` only.

Production `pg_dump` must be the PostgreSQL 17 client inside `kode-vps-postgres`. The laptop test streamed the archive with host `pg_dump` 18.4 into server 17.11, and also ran the same flags with the 17.11 client inside the container. A newer client can write an archive the server's own `pg_restore` cannot read. The approved unit pins the 17 client.

## 5. Isolated test results

Disposable infrastructure, all on the workstation:

| Piece | Version / address |
| --- | --- |
| Postgres server | 17.11 (Debian), container `kode-bh21-pg`, `127.0.0.1:54329`, database `kode_drill` |
| Postgres client inside that container | `pg_dump` 17.11 |
| Host `pg_dump` / `pg_restore` used for the streamed archive | 18.4 |
| MinIO source | RELEASE.2025-10-15T17-29-55Z, `127.0.0.1:9100` |
| MinIO restore target | a second process on `127.0.0.1:9210` |
| `mc` | RELEASE.2025-08-13T08-35-41Z |
| `age` | 1.3.2 |
| `zstd` | 1.5.7 |
| `rclone` | 1.75.2, local filesystem as the stand-in remote |
| Shell | bash 3.2.57 |

The age identity used here was generated for this drill. It must not be reused for production. Sample object bodies were the strings written for the test.

### Database role

`kode_backup` was `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, plus `CONNECT` on `kode_drill` and `pg_read_all_data`.

| Check | Result |
| --- | --- |
| `CONNECT` only, no `pg_read_all_data` | `pg_dump` exit 1, `permission denied for schema work` |
| `pg_read_all_data` dump | tables, sequences, `work.card_count()`, and `btree_gist` present |
| Table created after the grant | included, so future tables do not need `ALTER DEFAULT PRIVILEGES` |
| `CREATE TABLE` | exit 1, `permission denied for schema work` |
| `DROP TABLE work.cards` | exit 1, `must be owner of table cards` |
| `ALTER ROLE ... SUPERUSER` | permission denied |
| Connect to database `postgres` | succeeded |

`pg_read_all_data` is cluster-wide. `PUBLIC` has `CONNECT` on databases by default, so this role can read other databases on the same instance. The serving instance is the only place it may be created. Revoking `CONNECT` from `PUBLIC` can lock out administrative tools and is not part of this change. The dump command must name `kode_platform_staging`.

Large objects: with one large object present, `backup-set.sh` exited 3, wrote state `failed`, and did not create `LATEST_OK`. The PostgreSQL 17.11 client dump with `--no-large-objects` then succeeded. `pg_restore -l` on that archive contained 0 `BLOB` entries. Production had 0 large objects on 28 October 2026. If that count ever changes, the job fails closed instead of publishing a dump that silently omits them.

`pipefail`: a dump of a missing table piped to `zstd | age` exited 0 without `pipefail` and exited 1 with `pipefail`. `LATEST_OK` stayed on the previous good stamp.

### Objects and encryption

Seven buckets were listed. `profile-pictures` was empty and was still recorded with object count 0. After a source object was deleted, the older set still contained it and the next set did not. The public manifest contained neither `payslip.txt`, `org/conv/file.txt`, nor the test config secret. Cipher files were mode `600`.

The read-only MinIO user was denied `mc rm` (`Access Denied`) and denied `mc pipe` (`Insufficient permissions`). A user with no policy was denied `mc cat`. The backup path uses `mc cat` and `mc ls` only.

`mc mirror` was not used for the off-site copy. On this `mc` build, a default remirror of a changed object refused overwrite, `--overwrite` replaced it, and `--overwrite=false` against an existing object exited 0 and left the old content. The script does not depend on that flag.

### Success marker

| Run | Exit | Marker afterwards |
| --- | --- | --- |
| Large object present | 3 | no `LATEST_OK` |
| `SETOK2` verified | 0 | `SETOK2` |
| `SETBAD` one extra byte appended to the cipher dump before verification | 5, checksum mismatch | still `SETOK2` |
| `SETKEEP3` remote check, then staging deleted | 0 | `SETKEEP3` |
| `SETBAD2` after that | 5 | still `SETKEEP3` |
| Second invocation of an existing stamp | 2, refuses to replace | unchanged |

`rclone check --download` reported 0 differences and 8 matching files for `SETKEEP3`. The local set directory and the local `.age` files were gone after publication. The remote manifest state was `complete`.

Guards, all exit 2: age identity present, `PGHOST=128.140.124.44`, port `5433` with database `kode_platform_staging`, and a local directory without the test flag. The restore script also exited 2 for port `5433` and for database name `kode_platform_staging`.

### Restore

`restore-drill.sh` on `SETOK2`, into empty database `kode_restore_script` and the second MinIO:

- ciphertext check passed
- `work.cards` 2, `work.added_later` 1, `chat.messages` 1
- `attachment_key` matched the source database
- SHA-256 matched for the chat image, the chat attachment, the content-review object, the employee document, and the branding object
- 5 objects restored
- elapsed time about 1 second

That elapsed time is the tiny sample. It is not a production recovery-time measurement.

A later run downloaded `SETKEEP2` from the stand-in remote onto a fresh directory and restored it into `kode_restore_remote`: `work.cards` 2, `chat.messages` 1, and the chat-attachment bytes matched the source. The config bundle decrypted and contained the test secret. The public manifest did not.

`SETBAD` was refused: `refusing a set that is not complete`.

Application membership checks for chat attachments were not executed. The disposable rows are not a production membership graph, and this stage does not start the API against a copy. The drill restored the key and the object. The authorization check belongs to the later drill that runs the application against that copy.

## 6. Storage and resource requirements

Measured on 28 October 2026, from the BH-1 read-only pass:

- Disk `/`: 150 GB, 56 GB used, 89 GB available.
- `kode_platform_staging`: 53 MB.
- `/var/backups/itsnomatata`: 7.1 GB, of which 7.0 GB is the September hardlink tree of the old Supabase volume. That is not today's MinIO size.
- The live MinIO volume size was not measurable. `du` of the Docker volume was denied, and a signed metrics request returned HTTP 403. Walking every object was not done.

The size gate from BH-2 stays in force. Before the first production copy, an approved read-only measurement must record MinIO bytes. Required headroom is measured object bytes × 1.3 + 5 GB. The job refuses to start if the remaining free space would fall under 20 GB. The 1.3 factor covers age overhead, a compressed dump, config, transfer retries, and concurrent media processing. Already-compressed video will not shrink at `zstd -3`; the cipher is slightly larger than the object, not smaller.

Local staging holds one set at a time. After the remote check passes, the script deletes that staging copy. Peak extra space on the VPS is about one set, not two. The streamed `rclone check --download` does not keep a second tree. The quarterly drill downloads the set onto a different machine.

Do not run `zstd -19` or `-T0`. The approved bounds are `nice -n 19`, `zstd -3 -T1`, one object stream, and rclone at 8 MiB/s with one transfer. At 53 MB the database stream is small. The unknown quantity is MinIO.

Redis is not part of the backup. It is a cache.

## 7. Recovery-consistency limitations

What this design actually guarantees, without application changes and without enabling bucket versioning:

- The `pg_dump` is a transactionally consistent snapshot of `kode_platform_staging` at the moment the dump starts.
- Each object set is a complete copy of the objects `mc ls` could see while that bucket was listed, encrypted one at a time afterwards.
- An object deleted after the dump and before its bucket is copied can be named in Postgres and absent from today's set. Yesterday's set still has it, if retention keeps at least two sets. The disposable test showed this: `kode-staging/sample.txt` remained in `SETOK` and was absent from `SETOK2` after the source delete.
- An object uploaded after the dump is in the object set and not in that dump. The next day's dump sees the row.
- A resumable upload that has not finished is not a complete object. The copy includes only objects MinIO lists as files. Recovery of an interrupted upload is the same as a crash today: the database row and the object can already disagree.
- Replacing an object between the dump and the copy stores the new bytes with the old row, or the reverse, depending on which side is seen first. The pair is consistent with some moment inside the backup window, not with a single instant.
- Object counts prove the inventory is complete. They do not prove the bytes. The SHA-256 of the retained ciphertext does. `SETBAD` had the right file count and failed the checksum.
- Large objects are refused, not skipped. Production had zero on the audit date.
- Versioning was not enabled on the disposable buckets and must not be enabled on production under this stage. Versioning would keep a deleted object without relying on the previous set. That is a separate authorization.
- No application code change is required for the guarantees above. The window between the dump and the end of the object copy remains a consistency gap. Keeping 14 daily sets makes the previous set the recovery source for a delete inside that window.

A restore of set N produces the database as of the dump and the objects that were still present during the copy. Where a row points at an object deleted inside the window, the operator restores that one object from set N-1. The scripts do not do that automatically.

## 8. Off-site destination requirements

No off-site remote is configured today. BH-2 could not read `backup.env`, and no rclone remote was found from the available account. The destination has to be created before the first backup.

Required properties:

- Client-side age ciphertext only. Server-side encryption is additional, not the design.
- A private bucket. Public visibility would publish the ciphertext and the manifest.
- Credentials that can upload this bucket and cannot delete retained objects.
- Retention that the upload credential cannot shorten.
- A naming scheme `sets/<stamp>/` so a new run cannot overwrite an old one.
- An identity that is not stored with the ciphertext.
- An alert when `LATEST_OK` is older than 26 hours, and a separate alert when the scheduled restore drill is overdue.
- A tested restore on a machine other than the production VPS.

### Hetzner Object Storage

This is the recommended destination, with the limits Hetzner documents:

- Object Lock has to be enabled when the bucket is created. It cannot be turned on later. Creation with Object Lock also enables versioning, which then cannot be disabled. Source: [Buckets & objects](https://docs.hetzner.com/storage/object-storage/faq/buckets-objects/) and [Object Lock: Retention](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/protect-object-lock-retention/).
- Compliance retention cannot be ended early. Governance can, with a bypass permission. Use Compliance, 14 days as the minimum, matching the daily retention on the VPS. Longer monthly copies need a longer compliance period or a second bucket.
- An overwrite of the same name adds a new version. It does not remove the locked version. Append-only set prefixes still avoid depending on that behavior. `rclone copy --immutable` fails if a destination file would change.
- An access key can see every bucket in the same project. The backup bucket must live in a project that contains nothing else. A bucket policy can deny `s3:DeleteObject` for the upload key. Compliance mode is the control that still holds if that policy is wrong.
- The documented server-side encryption type is SSE-C. This design does not use it. Age already encrypted the bytes, and SSE-C would require another secret on the VPS.
- Hetzner states that data is stored while the contract is active, and that Compliance mode does not extend the contract. Account termination can end storage before the retention date. The lock protects against credential misuse. It does not protect against the account being closed.
- Bucket visibility must be private.

Hetzner Storage Box is not the destination. Snapshots there are not Object Lock, and the account holder can delete them.

### Backblaze B2 alternative

Use B2 if the upload key itself must be incapable of delete, rather than merely aimed at a locked bucket. B2 application keys can omit `deleteFiles`. Compliance retention cannot be removed; the retention date can be extended by a key that has the retention capabilities. The upload key must not have `writeKeys`, because that capability can create a new key with broader access. Sources: [application key capabilities](https://www.backblaze.com/docs/cloud-storage-application-key-capabilities) and [Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock).

Either provider is acceptable. Hetzner keeps the data in the same company as the VPS and still in a separate project and a separate credential. B2 is the stricter key model. Pick one before the first backup. Do not configure both in the same change.

Suggested retention once the size gate passes: 14 daily sets, 4 weekly, 6 monthly, for the database, config, and object sets together. A weekly or monthly set is a daily set that is kept, not a second copy format. Object sets are the large part. If the size gate says the VPS cannot hold one staging set, the job does not run; it does not fall back to a plaintext mirror.

## 9. Approval boundaries

Approved by this document: the design, the scripts, and the disposable results above.

Still requiring an explicit approval, each as its own change:

| Change | What it touches | What it must not touch |
| --- | --- | --- |
| Permission hardening | `chmod 700 /var/backups/itsnomatata` and `chmod -R go-rwx` on that tree only | No delete, move, or rewrite. Not `/opt/itsnomatata-api`. Caddy is mounted from `/opt/itsnomatata-api/stack/volumes/proxy/caddy`. No process found mounts `/var/backups/itsnomatata`. |
| Preserve volumes | Leave `kode-restore-pgdata` and `kode-cdn-migration-rehearsal-data` in place | They are not backup scratch and not the daily target |
| Age identity | Generate the production key pair on an operator machine. Copy only the public key to the VPS | The identity file does not go on the VPS |
| Destination | New Hetzner project, or a B2 bucket, with Object Lock at creation and Compliance retention | No use of the application MinIO bucket as the destination |
| Upload credential | Least privilege on that bucket | No production MinIO write key in the backup unit |
| Mailbox | Address for timer failure and for `LATEST_OK` older than 26 hours | |
| Role | `kode_backup` on the serving instance only, using the SQL file | Not on the restore volume, not on the CDN rehearsal volume, not a superuser |
| Read-only MinIO user | `s3:GetBucketLocation`, `ListBucket`, `GetObject` on the seven buckets | No delete, no put, no admin |
| Size measurement | Read-only byte count of the seven buckets | No full object walk if a bucket stat is available. No backup until the gate passes |
| First backup | The script, after the gate, with the production `pg_dump` 17 client | No `restore-backup.sh`, no `mc mirror` of plaintext, no `zstd -19` |
| Drill | A different machine, disposable Postgres and MinIO, sanitized or copied data | The tooling refuses the production host, address, port, and database name |

Until those approvals exist, the production server keeps the September Supabase archives as they are, including the overly broad modes. Leaving them world-readable is the current defect. Changing the mode is the first approved write, and it is still a write.

## 10. Implementation plan

Do these in order. Stop at the first failure. Each numbered step is a separate approval except where it says otherwise.

1. Record the MinIO byte count with a read-only credential. Apply the free-space gate. If it fails, stop. Do not start a copy.
2. Harden `/var/backups/itsnomatata` to mode `700` and remove group and other bits. Confirm Caddy still serves `api.tmctechsolutions.com` and `meet.itsnomatata.com`. Confirm the two extra Postgres volumes are still present and were not modified.
3. Generate the age key pair off the server. Record who holds each identity copy. Install only the public key at `/etc/kode-backup/recipient.pub`, mode `644`. Confirm the identity file is absent on the VPS.
4. Create the destination bucket with Object Lock enabled and Compliance retention of at least 14 days. Confirm the project or account contains no application buckets. Create the upload credential. From a workstation, upload a one-byte probe, list it, and confirm the upload credential cannot delete it before retention expires. Delete is expected to fail. Leave the probe until retention expires.
5. Create `kode_backup` from `deploy/backup/sql/kode_backup_role.sql` on the serving instance. Store the password in `/etc/kode-backup/backup.env`, mode `600`, root. Confirm `pg_dump` of `kode_platform_staging` with `--no-large-objects` can start and that `CREATE` and `DROP` fail. Confirm `SELECT count(*) FROM pg_largeobject_metadata` is 0. If it is not 0, stop and report. Do not switch the job to a superuser to get past that check.
6. Create the MinIO read-only user. Confirm `mc cat` works and `mc rm` returns Access Denied.
7. Install the scripts under `/opt/kode-platform/deploy/backup/`. The unit's `pg_dump` is `docker exec` of the 17 client in `kode-vps-postgres`. The environment has `KODE_RCLONE_REMOTE` set and does not have `KODE_BACKUP_ALLOW_LOCAL_OFFSITE` or `AGE_IDENTITY`.
8. Run one manual set at a time when the API and LiveKit are otherwise idle. Watch load. The set is published only if the script prints the stamp and `LATEST_OK` matches it. Confirm the remote manifest state is `complete` and the local staging directory is gone.
9. On a different machine, download that set and run `restore-drill.sh` against empty local Postgres and MinIO. Check row counts, one chat `attachment_key` and its object, one content-review object, and one organization-branding object. Start the application against that copy and confirm an authorized member can read the chat attachment and an unauthorized user cannot. Record the wall time. That time replaces the unmeasured recovery-time target.
10. Enable the 02:00 UTC timer and the failure mail. The mail fires on a non-zero unit exit and on `LATEST_OK` older than 26 hours. A calendar reminder, separate from `LATEST_OK`, fires when the last drill is older than 90 days.

The seven bucket names the script requires are `chat-images`, `chat-attachments`, `content-review-assets`, `employee-documents`, `kode-staging`, `organization-branding`, and `profile-pictures`.

## 11. Production rollback and failure recovery

### While introducing the job

- Bad role: `DROP ROLE kode_backup`. Application traffic uses `kode_staging`. Dropping the backup role does not restart the API.
- Bad MinIO user: remove `kode-backup-read`. The application uses the existing MinIO credentials.
- Bad timer: `systemctl disable --now kode-backup.timer`. Sets already uploaded stay. Compliance retention is what keeps them.
- Bad first set: leave it. Do not delete a remote object to "clean up" during the retention window. A failed run does not move `LATEST_OK`. The next stamp is a new directory.
- Permission hardening rollback: `chmod 755 /var/backups/itsnomatata` restores the old mode if something unexpected loses access. Do not chmod the Caddy directory as part of that rollback.
- The historical archives and the two extra Postgres volumes are not deleted by any step above.

### When a backup fails later

- The unit exits non-zero, the run state is `failed`, and `LATEST_OK` still names the previous verified set.
- Staging files for the failed stamp may remain on the VPS. They are ciphertext. Remove that stamp's staging directory after confirming `LATEST_OK` does not name it. Do not remove other stamps.
- A partial remote upload without a `complete` manifest is not a recovery point. `restore-drill.sh` refuses it. Leave the partial objects until retention expires rather than granting a delete credential to the VPS.
- The alert is the operator signal. The next night's run uses a new stamp.

### When the VPS is lost

Recovery needs three things that do not live only on that VPS: the latest `complete` set, the age identity, and the destination credential that can read. The upload credential may be read-only at that point; a separate read credential is acceptable if it also cannot delete.

1. On a new machine, refuse any configuration that points `PGHOST` at `128.140.124.44` or port `5433`. The restore script does this itself.
2. Download `sets/<stamp>/` for the stamp in the remote manifest whose state is `complete`. If the newest stamp is not `complete`, use the previous one.
3. Decrypt the config bundle with the identity. Recreate environment files, LiveKit config, and the Caddyfile from that bundle. The identity never goes onto the replacement server's backup job; it is used for this restore and then removed from that machine.
4. Restore Postgres into a new empty database with `restore-drill.sh`.
5. Restore the seven buckets into a new empty MinIO.
6. For any database key whose object is missing, copy that object from the previous complete set.
7. Start the application against the copy. Check chat attachment authorization, a content-review object, and a branding object before pointing DNS at the new host.
8. Generate a new age recipient after recovery if the old identity was used on the new machine, and start new sets with the new public key. Keep the old identity until the old sets expire.

A lost identity, with the VPS also lost, ends this recovery path. There is no second copy of the key on the server to fall back to. That is the trade for keeping the decryption key off the machine that an attacker would take first.
