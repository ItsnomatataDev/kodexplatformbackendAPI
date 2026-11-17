#!/usr/bin/env bash
# Disposable readiness tests for the backup scripts.
# Never points at the production host, address, or port.
set -euo pipefail
umask 077

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
CASE_DIR="${TMPDIR:-/tmp}/bh22-cases"
rm -rf "$CASE_DIR"
mkdir -p "$CASE_DIR"
PASS=0
cleanup_infra() {
  docker rm -f kode-bh22-pg >/dev/null 2>&1 || true
  if [ -f /tmp/bh22-minio.pid ]; then
    kill "$(cat /tmp/bh22-minio.pid)" >/dev/null 2>&1 || true
  fi
  if [ -f /tmp/bh22-minio-restore.pid ]; then
    kill "$(cat /tmp/bh22-minio-restore.pid)" >/dev/null 2>&1 || true
  fi
}
trap cleanup_infra EXIT

pass() { PASS=$((PASS + 1)); echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }

if rg -n "mc (rm|rb)|pg_restore|DROP TABLE|DELETE FROM|mc mirror" "$ROOT/backup-set.sh" >/dev/null; then
  fail "backup script contains a destructive or restore command"
fi
pass "backup script has no restore or source-delete command"

if rg -n "docker exec -e PGPASSWORD" "$ROOT/backup-set.sh" "$ROOT/restore-drill.sh" >/dev/null; then
  fail "password is passed through docker exec -e"
fi
pass "password is not placed on the docker exec command line"

backup() {
  # shellcheck disable=SC2068
  bash "$ROOT/backup-set.sh" >"$CASE_DIR/$1.out" 2>"$CASE_DIR/$1.err"
}

expect_backup() {
  local name="$1" want="$2"
  shift 2
  set +e
  env -u AGE_IDENTITY "$@" bash "$ROOT/backup-set.sh" >"$CASE_DIR/$name.out" 2>"$CASE_DIR/$name.err"
  local got=$?
  set -e
  [ "$got" = "$want" ] || { echo "exit $got"; cat "$CASE_DIR/$name.err"; fail "$name"; }
  if rg -n "backup-only|drill-only|drill-secret-value|AGE-SECRET-KEY" "$CASE_DIR/$name.out" "$CASE_DIR/$name.err" >/dev/null; then
    fail "$name leaked a secret into output"
  fi
  pass "$name"
}

PIN="$CASE_DIR/pin"
mkdir -p "$PIN"
printf '%s\n' 'kodebackup:sets' >"$PIN/destination.pin"

prod_obs=(
  KODE_BACKUP_MODE=production
  KODE_BACKUP_CHECK_ONLY=1
  KODE_BACKUP_PIN_DIR="$PIN"
  KODE_OBSERVED_HOST=ubuntu-8gb-fsn1-2
  KODE_OBSERVED_PGHOST=127.0.0.1
  KODE_OBSERVED_PGPORT=5433
  KODE_OBSERVED_PGUSER=kode_backup
  KODE_OBSERVED_PGDATABASE=kode_platform_staging
  KODE_OBSERVED_MC_ALIAS=kode-backup-read
  KODE_OBSERVED_RCLONE_REMOTE=kodebackup:sets
  KODE_OBSERVED_STACK=kode-platform-vps
  KODE_OBSERVED_PG_CONTAINER=kode-vps-postgres
  KODE_OBSERVED_BACKUP_ROOT=/var/backups/kode-platform
  KODE_BACKUP_ROOT=/tmp/bh22-unused
  KODE_OFFSITE_DIR=/tmp/bh22-unused
)
expect_backup prod-accept 0 "${prod_obs[@]}"
rg -q "source_authorized" "$CASE_DIR/prod-accept.out"

expect_backup prod-wrong-db 2 "${prod_obs[@]/KODE_OBSERVED_PGDATABASE=kode_platform_staging/KODE_OBSERVED_PGDATABASE=postgres}"
expect_backup prod-supabase-user 2 "${prod_obs[@]/KODE_OBSERVED_PGUSER=kode_backup/KODE_OBSERVED_PGUSER=postgres}"
expect_backup prod-bad-dest 2 "${prod_obs[@]/KODE_OBSERVED_RCLONE_REMOTE=kodebackup:sets/KODE_OBSERVED_RCLONE_REMOTE=other:sets}"
expect_backup prod-app-dest 2 "${prod_obs[@]/KODE_OBSERVED_RCLONE_REMOTE=kodebackup:sets/KODE_OBSERVED_RCLONE_REMOTE=kodebackup:128.140.124.44/sets}"
expect_backup prod-identity 2 KODE_OBSERVED_AGE_IDENTITY=1 "${prod_obs[@]}"
expect_backup prod-old-stack 2 "${prod_obs[@]/KODE_OBSERVED_STACK=kode-platform-vps/KODE_OBSERVED_STACK=supabase}"
expect_backup prod-here 2 \
  KODE_BACKUP_MODE=production \
  KODE_BACKUP_ROOT=/tmp/bh22-unused \
  KODE_OFFSITE_DIR=/tmp/bh22-unused \
  PGHOST=127.0.0.1 PGPORT=1 PGUSER=kode_backup PGDATABASE=kode_platform_staging \
  MC_SOURCE_ALIAS=kode-backup-read KODE_SOURCE_STACK=kode-platform-vps \
  KODE_PG_DOCKER_CONTAINER=kode-vps-postgres KODE_RCLONE_REMOTE=kodebackup:sets \
  AGE_RECIPIENT=age1example PGPASSWORD=unused MC_CONFIG_DIR=/tmp
if rg -n "connection refused|timeout" "$CASE_DIR/prod-here.err" >/dev/null; then
  fail "production mode contacted a database before the hostname guard"
fi
pass "production mode stopped before connecting"

# Infrastructure. Ports are loopback-only and are not the production port.
docker rm -f kode-bh22-pg >/dev/null 2>&1 || true
docker run -d --name kode-bh22-pg \
  -e POSTGRES_USER=kode_owner -e POSTGRES_PASSWORD=drill-only -e POSTGRES_DB=kode_drill \
  -p 127.0.0.1:54339:5432 postgres:17 >/dev/null
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if docker exec kode-bh22-pg pg_isready -U kode_owner -d kode_drill >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" = "1" ] || fail "disposable Postgres did not become ready"

docker exec -i kode-bh22-pg psql -U kode_owner -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE kode_staging WITH LOGIN SUPERUSER PASSWORD 'staging-only';
CREATE DATABASE kode_platform_staging OWNER kode_staging;
SQL
docker exec -i kode-bh22-pg psql -U kode_staging -d kode_platform_staging -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA work;
CREATE TABLE work.cards (id int primary key, name text);
INSERT INTO work.cards VALUES (1, 'a');
CREATE TABLE work.secret_later (id int);
SQL
docker cp "$ROOT/sql/kode_backup_role.sql" kode-bh22-pg:/tmp/kode_backup_role.sql
printf '%s\n' 'KODE_BACKUP_PASSWORD=backup-only' | docker exec -i kode-bh22-pg sh -c 'umask 077; cat > /dev/shm/role.env'
docker exec -i kode-bh22-pg sh -c 'set -a; . /dev/shm/role.env; set +a; rm -f /dev/shm/role.env; psql -U kode_owner -d kode_platform_staging -v ON_ERROR_STOP=1 -f -' <<'SQL'
\getenv kode_backup_password KODE_BACKUP_PASSWORD
\ir /tmp/kode_backup_role.sql
SQL
docker exec -i kode-bh22-pg psql -U kode_staging -d kode_platform_staging -c "CREATE TABLE work.added_later (id int);"
docker exec -e PGPASSWORD=backup-only kode-bh22-pg \
  psql -h 127.0.0.1 -p 5432 -U kode_backup -d kode_platform_staging -c "SELECT rolpassword FROM pg_authid LIMIT 1;" \
  >"$CASE_DIR/authid.out" 2>"$CASE_DIR/authid.err" || true
rg -q "permission denied for table pg_authid" "$CASE_DIR/authid.err" || fail "scoped role read pg_authid"
pass "scoped role cannot read pg_authid"
docker exec -e PGPASSWORD=backup-only kode-bh22-pg \
  psql -h 127.0.0.1 -p 5432 -U kode_backup -d kode_platform_staging -Atc "SELECT count(*) FROM work.added_later;" \
  | rg -q '^0$' || fail "future table was not readable"
pass "default privileges cover a later table"
docker exec -e PGPASSWORD=backup-only kode-bh22-pg \
  pg_dump -h 127.0.0.1 -p 5432 -U kode_backup -d kode_platform_staging \
  -Fc --no-owner --no-privileges --no-large-objects -f /tmp/sqlfile.dump
docker exec kode-bh22-pg pg_restore -l /tmp/sqlfile.dump | rg -q "TABLE DATA work cards" || fail "sql role dump missed a table"
blobs="$(docker exec kode-bh22-pg pg_restore -l /tmp/sqlfile.dump | rg -c "BLOB" || true)"
[ "${blobs:-0}" = "0" ] || fail "sql role dump included large objects"
pass "production role SQL dumps with the PostgreSQL 17 client"

docker exec -i kode-bh22-pg psql -U kode_owner -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DROP DATABASE kode_platform_staging;
CREATE DATABASE side_data OWNER kode_owner;
\connect side_data
CREATE TABLE public.secret_docs (body text);
SQL
side_priv="$(docker exec -e PGPASSWORD=backup-only kode-bh22-pg psql -h 127.0.0.1 -p 5432 -U kode_backup -d side_data -Atc "SELECT has_table_privilege(current_user, 'public.secret_docs', 'SELECT');")"
[ "$side_priv" = "f" ] || fail "backup role can select another database"
pass "backup role cannot read another database"
docker exec -i kode-bh22-pg psql -U kode_owner -d postgres -c "DROP DATABASE side_data;" >/dev/null

docker exec -i kode-bh22-pg psql -U kode_owner -d kode_drill -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA work;
CREATE TABLE work.cards (id int primary key, name text);
INSERT INTO work.cards VALUES (1, 'a'), (2, 'b');
CREATE TABLE work.card_attachments (bucket text, object_key text);
INSERT INTO work.card_attachments VALUES
  ('chat-attachments', 'org/conv/file.txt');
CREATE SCHEMA chat;
CREATE TABLE chat.messages (attachment_url text);
INSERT INTO chat.messages VALUES
  ('/api/chat/media/chat-attachments/org/conv/file.txt'),
  ('https://example.invalid/not-a-storage-url');
CREATE SCHEMA content;
CREATE TABLE content.upload_sessions (bucket text, object_key text, state text);
INSERT INTO content.upload_sessions VALUES
  ('content-review-assets', 'still-uploading.bin', 'uploading');
GRANT USAGE ON SCHEMA work, chat, content TO kode_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA work, chat, content TO kode_backup;
SQL

rm -rf /tmp/bh22-minio-data /tmp/bh22-minio-restore
mkdir -p /tmp/bh22-minio-data /tmp/bh22-minio-restore /tmp/bh22-mc
MINIO_ROOT_USER=bh22admin MINIO_ROOT_PASSWORD=bh22admin-secret \
  minio server /tmp/bh22-minio-data --address 127.0.0.1:19100 --console-address 127.0.0.1:19101 \
  >/tmp/bh22-minio.log 2>&1 &
echo $! >/tmp/bh22-minio.pid
MINIO_ROOT_USER=restoreadmin MINIO_ROOT_PASSWORD=restore-secret \
  minio server /tmp/bh22-minio-restore --address 127.0.0.1:19210 --console-address 127.0.0.1:19211 \
  >/tmp/bh22-minio-restore.log 2>&1 &
echo $! >/tmp/bh22-minio-restore.pid
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if curl -fsS http://127.0.0.1:19100/minio/health/live >/dev/null 2>&1 && curl -fsS http://127.0.0.1:19210/minio/health/live >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.3
done
[ "$ready" = "1" ] || fail "disposable MinIO did not become ready"

export MC_CONFIG_DIR=/tmp/bh22-mc
mc alias set src http://127.0.0.1:19100 bh22admin bh22admin-secret >/dev/null
for bucket in chat-images chat-attachments content-review-assets employee-documents kode-staging organization-branding profile-pictures; do
  mc mb "src/$bucket" >/dev/null
done
printf 'chat-bytes' | mc pipe src/chat-attachments/org/conv/file.txt >/dev/null
: > /tmp/bh22-empty.bin
mc cp /tmp/bh22-empty.bin src/chat-images/empty.bin >/dev/null
printf 'doc' | mc pipe src/employee-documents/payslip.txt >/dev/null
printf 'review' | mc pipe src/content-review-assets/asset.txt >/dev/null
printf 'logo1' | mc pipe src/organization-branding/logo.txt >/dev/null
printf 'v1' | mc pipe src/kode-staging/sample.txt >/dev/null

python3 - <<'PY'
import json
buckets = ["chat-images","chat-attachments","content-review-assets","employee-documents","kode-staging","organization-branding","profile-pictures"]
resources = []
for bucket in buckets:
    resources.extend([f"arn:aws:s3:::{bucket}", f"arn:aws:s3:::{bucket}/*"])
policy = {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket","s3:GetObject"],"Resource":resources}]}
open("/tmp/bh22-readonly.json","w").write(json.dumps(policy))
PY
mc admin user add src kode-backup-read read-secret >/dev/null
mc admin policy create src drill-read /tmp/bh22-readonly.json >/dev/null
mc admin policy attach src drill-read --user kode-backup-read >/dev/null
mc alias set drill-reader http://127.0.0.1:19100 kode-backup-read read-secret >/dev/null
mc rm --force drill-reader/employee-documents/payslip.txt >"$CASE_DIR/reader-rm.out" 2>"$CASE_DIR/reader-rm.err" || true
rg -q "Access Denied" "$CASE_DIR/reader-rm.err" || fail "read-only user deleted an object"
printf 'no' | mc pipe drill-reader/chat-images/new.txt >"$CASE_DIR/reader-put.out" 2>"$CASE_DIR/reader-put.err" || true
rg -q "Insufficient permissions" "$CASE_DIR/reader-put.err" || fail "read-only user wrote an object"
pass "read-only MinIO user cannot write or delete"

rm -f /tmp/bh22-age.txt /tmp/bh22-age.pub
age-keygen -o /tmp/bh22-age.txt >/dev/null 2>&1
age-keygen -y /tmp/bh22-age.txt >/tmp/bh22-age.pub
mkdir -p /tmp/bh22-config
printf 'DATABASE_PASSWORD=drill-secret-value\n' >/tmp/bh22-config/app.env
printf '%s\n' /tmp/bh22-config/app.env >/tmp/bh22-config.list
rm -rf /tmp/bh22-root /tmp/bh22-offsite /tmp/bh22-remote /tmp/bh22-control
mkdir -p /tmp/bh22-root /tmp/bh22-offsite /tmp/bh22-remote /tmp/bh22-control

REAL_DOCKER=$(command -v docker)
REAL_MC=$(command -v mc)
REAL_AGE=$(command -v age)
REAL_RCLONE=$(command -v rclone)
REAL_DF=$(command -v df)
mkdir -p /tmp/bh22-bin
cat > /tmp/bh22-bin/docker <<EOF
#!/bin/sh
if [ -f "\$BH22_CONTROL/fail-dump" ] && echo " \$* " | grep -q " pg_dump " && ! echo " \$* " | grep -q -- "--version"; then
  echo "pg_dump: simulated failure" >&2
  exit 1
fi
exec "$REAL_DOCKER" "\$@"
EOF
cat > /tmp/bh22-bin/mc <<EOF
#!/bin/sh
if [ -f "\$BH22_CONTROL/vanish" ] && [ "\$1" = "cat" ]; then
  echo "Object does not exist" >&2
  exit 1
fi
if [ -f "\$BH22_CONTROL/replace" ] && [ "\$1" = "stat" ]; then
  echo '{"etag":"replaced-etag","size":1}'
  exit 0
fi
exec "$REAL_MC" "\$@"
EOF
cat > /tmp/bh22-bin/age <<EOF
#!/bin/sh
if [ -f "\$BH22_CONTROL/fail-age" ]; then
  echo "age: simulated failure" >&2
  exit 1
fi
exec "$REAL_AGE" "\$@"
EOF
cat > /tmp/bh22-bin/rclone <<EOF
#!/bin/sh
if [ -f "\$BH22_CONTROL/fail-copy" ] && echo " \$* " | grep -q " copy "; then
  echo "upload interrupted" >&2
  exit 1
fi
if [ -f "\$BH22_CONTROL/fail-connect" ] && echo " \$* " | grep -q " copy "; then
  echo "connection reset by peer" >&2
  exit 1
fi
if [ -f "\$BH22_CONTROL/fail-check" ] && echo " \$* " | grep -q " check "; then
  echo "checksum mismatch" >&2
  exit 1
fi
exec "$REAL_RCLONE" "\$@"
EOF
cat > /tmp/bh22-bin/df <<EOF
#!/bin/sh
if [ -f "\$BH22_CONTROL/df-low" ]; then
  echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
  echo "fake 1000000 0 1000000 0% /tmp"
  exit 0
fi
exec "$REAL_DF" "\$@"
EOF
chmod 755 /tmp/bh22-bin/*
export PATH="/tmp/bh22-bin:$PATH"
export BH22_CONTROL=/tmp/bh22-control

common=(
  KODE_BACKUP_MODE=drill
  KODE_BACKUP_ROOT=/tmp/bh22-root
  KODE_OFFSITE_DIR=/tmp/bh22-offsite
  KODE_BACKUP_ALLOW_LOCAL_OFFSITE=1
  KODE_RCLONE_REMOTE=/tmp/bh22-remote
  AGE_RECIPIENT="$(cat /tmp/bh22-age.pub)"
  PGHOST=127.0.0.1
  PGPORT=54339
  PGUSER=kode_backup
  PGDATABASE=kode_drill
  PGPASSWORD=backup-only
  MC_CONFIG_DIR=/tmp/bh22-mc
  MC_SOURCE_ALIAS=drill-reader
  KODE_PG_DOCKER_CONTAINER=kode-bh22-pg
  KODE_CONFIG_LIST=/tmp/bh22-config.list
  BH22_CONTROL=/tmp/bh22-control
)

expect_backup drill-prod-db 2 "${common[@]}" PGDATABASE=kode_platform_staging KODE_BACKUP_STAMP=REJECTDB
expect_backup drill-prod-port 2 "${common[@]}" PGPORT=5433 KODE_BACKUP_STAMP=REJECTPORT
expect_backup drill-public-host 2 "${common[@]}" PGHOST=128.140.124.44 KODE_BACKUP_STAMP=REJECTHOST
expect_backup drill-supabase 2 "${common[@]}" PGUSER=postgres KODE_BACKUP_STAMP=REJECTUSER
set +e
env -u AGE_IDENTITY "${common[@]}" AGE_RECIPIENT= bash "$ROOT/backup-set.sh" >"$CASE_DIR/missing-age.out" 2>"$CASE_DIR/missing-age.err"
got=$?
set -e
[ "$got" = "2" ] || fail "missing recipient exited $got"
pass "missing recipient"

# Large object fails closed before a success marker exists.
docker exec kode-bh22-pg psql -U kode_owner -d kode_drill -c "SELECT lo_from_bytea(0, 'x'::bytea);" >/dev/null
expect_backup large-object 3 "${common[@]}" KODE_BACKUP_STAMP=LOFAIL
[ ! -f /tmp/bh22-root/LATEST_OK ] || fail "large-object failure published LATEST_OK"
docker exec kode-bh22-pg psql -U kode_owner -d kode_drill -c "SELECT lo_unlink(oid) FROM pg_largeobject_metadata;" >/dev/null
pass "large-object preflight left no success marker"

expect_backup good 0 "${common[@]}" KODE_BACKUP_STAMP=GOOD
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "GOOD" ] || fail "LATEST_OK"
[ ! -d /tmp/bh22-offsite/sets/GOOD ] || fail "local staging was kept"
[ ! -e /tmp/bh22-root/runs/GOOD/pgpass ] || fail "pgpass remained"
python3 - <<'PY'
import json
manifest = json.load(open("/tmp/bh22-remote/sets/GOOD/manifest.public.json"))
assert manifest["state"] == "valid"
assert manifest["recovery_class"] == "valid"
text = open("/tmp/bh22-remote/sets/GOOD/manifest.public.json").read()
for needle in ("org/conv/file.txt", "missing/object.txt", "drill-secret-value", "DATABASE_PASSWORD", "payslip.txt"):
    assert needle not in text, needle
names = {item["name"] for item in manifest["buckets"]}
assert len(names) == 7
empty = [item for item in manifest["buckets"] if item["name"] == "profile-pictures"][0]
assert empty["object_count"] == 0
images = [item for item in manifest["buckets"] if item["name"] == "chat-images"][0]
assert images["object_count"] == 1 and images["plain_bytes"] == 0
assert manifest["consistency"]["missing"] == 0
assert manifest["consistency"]["in_progress"] >= 1
assert manifest["consistency"]["unparsed"] >= 1
assert manifest["consistency"]["recovery_class"] == "valid"
assert manifest["consistency"]["replaced"] == 0
assert manifest["consistency"]["stat_failed"] == 0
PY
pass "public manifest hides keys and records reference gaps"
# Cipher checksums are the integrity claim. A reference gap does not fail them.
rg -q "verified files=" "$CASE_DIR/good.out"

rm -rf /tmp/bh22-restore-good
mkdir -p /tmp/bh22-restore-good
rclone copy /tmp/bh22-remote/sets/GOOD /tmp/bh22-restore-good/sets/GOOD --checksum --transfers 1 >/dev/null
mc alias set drill-restore http://127.0.0.1:19210 restoreadmin restore-secret >/dev/null
for bucket in chat-images chat-attachments content-review-assets employee-documents kode-staging organization-branding profile-pictures; do
  mc mb "drill-restore/$bucket" >/dev/null
done
docker exec kode-bh22-pg psql -U kode_owner -d postgres -c "CREATE DATABASE kode_restore OWNER kode_owner;" >/dev/null
set +e
env KODE_RESTORE_CONFIRM=isolated \
  KODE_OFFSITE_DIR=/tmp/bh22-restore-good KODE_RESTORE_STAMP=GOOD \
  AGE_IDENTITY=/tmp/bh22-age.txt \
  PGHOST=127.0.0.1 PGPORT=54339 PGUSER=kode_owner PGDATABASE=kode_restore PGPASSWORD=drill-only \
  MC_CONFIG_DIR=/tmp/bh22-mc MC_RESTORE_ALIAS=drill-restore \
  KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore.out" 2>"$CASE_DIR/restore.err"
got=$?
set -e
[ "$got" = "0" ] || { cat "$CASE_DIR/restore.err"; fail "restore exited $got"; }
rows="$(docker exec kode-bh22-pg psql -U kode_owner -d kode_restore -Atc "SELECT count(*) FROM work.cards;")"
[ "$rows" = "2" ] || fail "restored card count $rows"
src_hash="$(mc cat src/chat-attachments/org/conv/file.txt | shasum -a 256 | awk '{print $1}')"
dst_hash="$(mc cat drill-restore/chat-attachments/org/conv/file.txt | shasum -a 256 | awk '{print $1}')"
[ "$src_hash" = "$dst_hash" ] || fail "attachment bytes differ"
empty_size="$(mc stat --json drill-restore/chat-images/empty.bin | python3 -c 'import json,sys; print(json.load(sys.stdin).get("size"))')"
[ "$empty_size" = "0" ] || fail "zero-byte object size $empty_size"
if mc stat drill-restore/chat-attachments/missing/object.txt >/dev/null 2>&1; then
  fail "a missing source object was invented on restore"
fi
age -d -i /tmp/bh22-age.txt /tmp/bh22-restore-good/sets/GOOD/index.ndjson.age >"$CASE_DIR/index.ndjson"
rg -q "org/conv/file.txt" "$CASE_DIR/index.ndjson" || fail "encrypted index lost the committed object"
age -d -i /tmp/bh22-age.txt /tmp/bh22-restore-good/sets/GOOD/consistency.ndjson.age >"$CASE_DIR/consistency.ndjson"
rg -q "still-uploading.bin" "$CASE_DIR/consistency.ndjson" && fail "an unfinished upload was stored as a missing object"
age -d -i /tmp/bh22-age.txt /tmp/bh22-restore-good/sets/GOOD/config.tar.zst.age | zstd -d | tar -x -O ./app.env | rg -q "drill-secret-value" || fail "config secret was not recoverable"
pass "full recovery from the encrypted set"

# Failure cases must not move the success marker.
: > /tmp/bh22-control/fail-dump
expect_backup dump-fail 1 "${common[@]}" KODE_BACKUP_STAMP=DUMPFAIL
rm -f /tmp/bh22-control/fail-dump
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "GOOD" ] || fail "dump failure moved LATEST_OK"
[ ! -f /tmp/bh22-remote/sets/DUMPFAIL/manifest.public.json ] || fail "failed dump published a manifest"
pass "failed dump did not publish"

: > /tmp/bh22-control/vanish
expect_backup missing-object 1 "${common[@]}" KODE_BACKUP_STAMP=VANISH
rm -f /tmp/bh22-control/vanish
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "GOOD" ] || fail "missing object moved LATEST_OK"
[ -d /tmp/bh22-offsite/sets/VANISH ] || fail "failed download deleted backup evidence"
pass "missing listed object did not publish"

: > /tmp/bh22-control/fail-age
expect_backup encrypt-fail 1 "${common[@]}" KODE_BACKUP_STAMP=AGEFAIL
rm -f /tmp/bh22-control/fail-age
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "GOOD" ] || fail "encryption failure moved LATEST_OK"
pass "failed encryption did not publish"

: > /tmp/bh22-control/fail-copy
expect_backup upload-fail 1 "${common[@]}" KODE_BACKUP_STAMP=COPYFAIL
rm -f /tmp/bh22-control/fail-copy
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "GOOD" ] || fail "interrupted upload moved LATEST_OK"
[ -f /tmp/bh22-offsite/sets/COPYFAIL/manifest.public.json ] || fail "interrupted transfer deleted local evidence"
pass "interrupted upload did not publish"

: > /tmp/bh22-control/fail-connect
expect_backup connect-fail 1 "${common[@]}" KODE_BACKUP_STAMP=CONFAIL
rm -f /tmp/bh22-control/fail-connect
rg -q "connection reset by peer" "$CASE_DIR/connect-fail.err" || fail "lost connection was not reported"
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "GOOD" ] || fail "lost connection moved LATEST_OK"
pass "lost off-site connection did not publish"

: > /tmp/bh22-control/fail-check
expect_backup checksum-fail 1 "${common[@]}" KODE_BACKUP_STAMP=CHECKFAIL
rm -f /tmp/bh22-control/fail-check
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "GOOD" ] || fail "checksum mismatch moved LATEST_OK"
if [ -f /tmp/bh22-remote/sets/CHECKFAIL/manifest.public.json ]; then
  fail "checksum mismatch published a manifest"
fi
pass "remote checksum mismatch did not publish"

set +e
env KODE_RESTORE_CONFIRM=isolated \
  KODE_OFFSITE_DIR=/tmp/bh22-remote KODE_RESTORE_STAMP=CHECKFAIL \
  AGE_IDENTITY=/tmp/bh22-age.txt \
  PGHOST=127.0.0.1 PGPORT=54339 PGUSER=kode_owner PGDATABASE=kode_restore PGPASSWORD=drill-only \
  MC_CONFIG_DIR=/tmp/bh22-mc MC_RESTORE_ALIAS=drill-restore \
  KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore-incomplete.out" 2>"$CASE_DIR/restore-incomplete.err"
got=$?
set -e
[ "$got" != "0" ] || fail "incomplete set was restored"
pass "incomplete set was refused"

expect_backup retry 0 "${common[@]}" KODE_BACKUP_STAMP=RETRY
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "RETRY" ] || fail "retry did not become the success marker"
expect_backup collision 2 "${common[@]}" KODE_BACKUP_STAMP=RETRY
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "RETRY" ] || fail "collision changed the success marker"
pass "retry after failure and same-stamp collision"

: > /tmp/bh22-control/df-low
expect_backup low-space 6 "${common[@]}" KODE_BACKUP_STAMP=SPACE
rm -f /tmp/bh22-control/df-low
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "RETRY" ] || fail "low space moved LATEST_OK"
pass "free-space gate"

mc rm --force src/chat-attachments/org/conv/file.txt >/dev/null
expect_backup prior-gap 0 "${common[@]}" KODE_BACKUP_STAMP=DEGRADE
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "RETRY" ] || fail "degraded backup replaced the fully recoverable set"
python3 - <<'PY'
import json
manifest = json.load(open("/tmp/bh22-remote/sets/DEGRADE/manifest.public.json"))
assert manifest["state"] == "degraded"
assert manifest["recovers_with"] == "RETRY"
assert manifest["consistency"]["missing"] >= 1
assert manifest["consistency"]["unrecoverable_gaps"] == 0
assert manifest["consistency"]["in_progress"] >= 1
PY
pass "missing object with a previous set stayed degraded"
mc cat drill-restore/chat-attachments/org/conv/file.txt | mc pipe src/chat-attachments/org/conv/file.txt >/dev/null

: > /tmp/bh22-control/replace
expect_backup replaced 0 "${common[@]}" KODE_BACKUP_STAMP=REPLACE
rm -f /tmp/bh22-control/replace
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "RETRY" ] || fail "replaced object replaced the fully recoverable set"
python3 - <<'PY'
import json
manifest = json.load(open("/tmp/bh22-remote/sets/REPLACE/manifest.public.json"))
assert manifest["consistency"]["replaced"] >= 1
assert manifest["state"] == "degraded"
assert manifest["recovers_with"] == "RETRY"
assert manifest["consistency"]["unrecoverable_gaps"] == 0
PY
pass "replaced object kept a verified recovery path"

docker exec -i kode-bh22-pg psql -U kode_owner -d kode_drill -c "INSERT INTO work.card_attachments VALUES ('chat-attachments', 'missing/object.txt');" >/dev/null
expect_backup unrecovered-gap 7 "${common[@]}" KODE_BACKUP_STAMP=GAP
[ "$(cat /tmp/bh22-root/LATEST_OK)" = "RETRY" ] || fail "incomplete backup replaced the fully recoverable set"
[ -f /tmp/bh22-offsite/sets/GAP/manifest.public.json ] || fail "incomplete evidence was deleted"
[ ! -f /tmp/bh22-remote/sets/GAP/manifest.public.json ] || fail "incomplete backup was published"
python3 - <<'PY'
import json
manifest = json.load(open("/tmp/bh22-offsite/sets/GAP/manifest.public.json"))
assert manifest["state"] == "incomplete"
assert manifest["consistency"]["recovery_class"] == "incomplete"
assert manifest["consistency"]["unrecoverable_gaps"] >= 1
PY
age -d -i /tmp/bh22-age.txt /tmp/bh22-offsite/sets/GAP/consistency.ndjson.age | rg -q "missing/object.txt" || fail "incomplete evidence lost the missing reference"
set +e
env KODE_RESTORE_CONFIRM=isolated \
  KODE_OFFSITE_DIR=/tmp/bh22-offsite KODE_RESTORE_STAMP=GAP \
  AGE_IDENTITY=/tmp/bh22-age.txt \
  PGHOST=127.0.0.1 PGPORT=54339 PGUSER=kode_owner PGDATABASE=kode_restore PGPASSWORD=drill-only \
  MC_CONFIG_DIR=/tmp/bh22-mc MC_RESTORE_ALIAS=drill-restore \
  KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore-gap.out" 2>"$CASE_DIR/restore-gap.err"
got=$?
set -e
[ "$got" != "0" ] || fail "incomplete backup was restored as recoverable"
pass "incomplete backup was kept and was not published"

set +e
env KODE_RESTORE_CONFIRM=isolated PGHOST=128.140.124.44 PGPORT=54339 PGUSER=kode_owner \
  PGDATABASE=kode_restore PGPASSWORD=drill-only KODE_OFFSITE_DIR=/tmp/bh22-restore-good \
  KODE_RESTORE_STAMP=GOOD AGE_IDENTITY=/tmp/bh22-age.txt MC_CONFIG_DIR=/tmp/bh22-mc \
  MC_RESTORE_ALIAS=drill-restore KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore-host.out" 2>"$CASE_DIR/restore-host.err"
got=$?
set -e
[ "$got" = "2" ] || fail "restore accepted a non-loopback database"
set +e
env KODE_RESTORE_CONFIRM=isolated PGHOST=127.0.0.1 PGPORT=5433 PGUSER=kode_owner \
  PGDATABASE=kode_restore PGPASSWORD=drill-only KODE_OFFSITE_DIR=/tmp/bh22-restore-good \
  KODE_RESTORE_STAMP=GOOD AGE_IDENTITY=/tmp/bh22-age.txt MC_CONFIG_DIR=/tmp/bh22-mc \
  MC_RESTORE_ALIAS=drill-restore KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore-port.out" 2>"$CASE_DIR/restore-port.err"
got=$?
set -e
[ "$got" = "2" ] || fail "restore accepted the production port"
python3 - <<'PY'
import json
path="/tmp/bh22-mc/config.json"
config=json.load(open(path))
config["aliases"]["bad-target"]={"url":"http://128.140.124.44:9000","accessKey":"x","secretKey":"y","api":"S3v4","path":"auto"}
json.dump(config, open(path,"w"))
PY
set +e
env KODE_RESTORE_CONFIRM=isolated PGHOST=127.0.0.1 PGPORT=54339 PGUSER=kode_owner \
  PGDATABASE=kode_restore PGPASSWORD=drill-only KODE_OFFSITE_DIR=/tmp/bh22-restore-good \
  KODE_RESTORE_STAMP=GOOD AGE_IDENTITY=/tmp/bh22-age.txt MC_CONFIG_DIR=/tmp/bh22-mc \
  MC_RESTORE_ALIAS=bad-target KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore-minio.out" 2>"$CASE_DIR/restore-minio.err"
got=$?
set -e
[ "$got" = "2" ] || fail "restore accepted a production MinIO endpoint"
pass "restore rejected production destinations"

set +e
env KODE_RESTORE_CONFIRM=isolated \
  KODE_OFFSITE_DIR=/tmp/bh22-remote KODE_RESTORE_STAMP=DEGRADE \
  AGE_IDENTITY=/tmp/bh22-age.txt \
  PGHOST=127.0.0.1 PGPORT=54339 PGUSER=kode_owner PGDATABASE=kode_restore PGPASSWORD=drill-only \
  MC_CONFIG_DIR=/tmp/bh22-mc MC_RESTORE_ALIAS=drill-restore \
  KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore-degraded-unconfirmed.out" 2>"$CASE_DIR/restore-degraded-unconfirmed.err"
got=$?
set -e
[ "$got" = "2" ] || fail "degraded set was restored without content-version review"
rg -q "does not prove those bytes match" "$CASE_DIR/restore-degraded-unconfirmed.err" || fail "degraded refusal omitted the compatibility limit"
pass "degraded set requires review before restore"

docker exec kode-bh22-pg psql -U kode_owner -d postgres -c "CREATE DATABASE kode_degraded OWNER kode_owner;" >/dev/null
set +e
env KODE_RESTORE_CONFIRM=isolated KODE_RESTORE_DEGRADED_CONFIRM=content-version-unproven \
  KODE_OFFSITE_DIR=/tmp/bh22-remote KODE_RESTORE_STAMP=DEGRADE \
  AGE_IDENTITY=/tmp/bh22-age.txt \
  PGHOST=127.0.0.1 PGPORT=54339 PGUSER=kode_owner PGDATABASE=kode_degraded PGPASSWORD=drill-only \
  MC_CONFIG_DIR=/tmp/bh22-mc MC_RESTORE_ALIAS=drill-restore \
  KODE_PG_DOCKER_CONTAINER=kode-bh22-pg \
  bash "$ROOT/restore-drill.sh" >"$CASE_DIR/restore-degraded.out" 2>"$CASE_DIR/restore-degraded.err"
got=$?
set -e
[ "$got" = "8" ] || { cat "$CASE_DIR/restore-degraded.err"; fail "reviewed degraded restore exited $got"; }
rg -q "degraded_bytes_restored_not_operational" "$CASE_DIR/restore-degraded.out" || fail "degraded restore was treated as operational"
rows="$(docker exec kode-bh22-pg psql -U kode_owner -d kode_degraded -Atc "SELECT count(*) FROM work.cards;")"
[ "$rows" = "2" ] || fail "degraded byte restore lost the database rows"
pass "degraded byte restore stayed short of operational acceptance"

cat >"$CASE_DIR/secret.env" <<'EOF'
DATABASE_PASSWORD=drill-secret-value
JWT_SECRET=jwt-value
MINIO_SECRET_KEY=minio-value
AGE_IDENTITY=AGE-SECRET-KEY-1EXAMPLE
EOF
chmod 600 "$CASE_DIR/secret.env"
KODE_DIAG_ENV_FILE="$CASE_DIR/secret.env" \
  KODE_BACKUP_PIN_FILE=/no/such/pin \
  KODE_AGE_RECIPIENT_FILE=/no/such/recipient \
  bash "$ROOT/diagnose.sh" >"$CASE_DIR/diag.out"
if rg -n "drill-secret-value|jwt-value|minio-value|AGE-SECRET-KEY-1EXAMPLE" "$CASE_DIR/diag.out" >/dev/null; then
  fail "diagnostics printed a secret value"
fi
rg -q "DATABASE_PASSWORD" "$CASE_DIR/diag.out" || fail "diagnostics omitted a variable name"
rg -q "age_private_key=present_remove_it" "$CASE_DIR/diag.out" || fail "diagnostics missed a private key"
pass "diagnostics are redacted"
set +e
env KODE_BACKUP_PASSWORD=backup-only bash "$ROOT/apply-backup-role.sh" >"$CASE_DIR/apply-role.out" 2>"$CASE_DIR/apply-role.err"
got=$?
set -e
[ "$got" = "2" ] || fail "role apply ran without an approved window"
if rg -n "backup-only" "$CASE_DIR/apply-role.out" "$CASE_DIR/apply-role.err" >/dev/null; then
  fail "role apply printed a password"
fi
pass "role apply stays closed without an approved window"

echo ALL_PASS "$PASS"
