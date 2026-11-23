#!/usr/bin/env bash
# Kode backup set. Production deployment is not authorized by this file.
# Encrypts the database dump, deployment config, and every object with age.
# This process never reads an age private key and never restores or deletes source data.
set -euo pipefail

umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=source-policy.sh
. "$SCRIPT_DIR/source-policy.sh"

PUBLISHED=0
holder_pid=""
pgpass=""
index_plain=""
config_stage=""
RUN=""
SET=""

atomic_write() {
  local dest="$1"
  local tmp="${dest}.tmp.$$"
  cat >"$tmp"
  mv -f "$tmp" "$dest"
}

set_state() {
  atomic_write "$RUN/state" <<<"$1"
}

release_snapshot() {
  if [ -n "${RUN:-}" ]; then
    : >"$RUN/snapshot.release" 2>/dev/null || true
  fi
  if [ -n "${holder_pid:-}" ]; then
    wait "$holder_pid" 2>/dev/null || true
    holder_pid=""
  fi
}

cleanup_incomplete() {
  release_snapshot
  if [ -n "${index_plain:-}" ]; then
    rm -f "$index_plain"
  fi
  if [ -n "${config_stage:-}" ]; then
    rm -rf "$config_stage"
  fi
  if [ -n "${pgpass:-}" ]; then
    rm -f "$pgpass"
  fi
  if [ -n "${KODE_PG_DOCKER_CONTAINER:-}" ]; then
    docker exec "$KODE_PG_DOCKER_CONTAINER" rm -f /dev/shm/kode-backup.pgpass >/dev/null 2>&1 || true
  fi
  # Keep encrypted artifacts and the set directory. Incomplete evidence is
  # not removed automatically. Plaintext secrets are removed.
  if [ -n "${RUN:-}" ] && [ -d "${RUN:-}" ]; then
    rm -rf "$RUN/config-src" "$RUN/bin"
    rm -f "$RUN/references.ndjson" "$RUN/index.plain.ndjson" \
      "$RUN"/list-*.ndjson "$RUN/buckets.ndjson" "$RUN/pgpass"
  fi
}

on_error() {
  trap '' ERR
  cleanup_incomplete
  if [ -n "${RUN:-}" ] && [ -d "${RUN:-}" ]; then
    printf '%s\n' failed >"${RUN}/state.tmp.$$"
    mv -f "${RUN}/state.tmp.$$" "${RUN}/state" || true
  fi
}

die() {
  local code="$1"
  shift
  [ "$#" -eq 0 ] || echo "$*" >&2
  trap '' ERR
  if [ -n "${RUN:-}" ] && [ -d "${RUN:-}" ]; then
    printf '%s\n' failed >"${RUN}/state.tmp.$$"
    mv -f "${RUN}/state.tmp.$$" "${RUN}/state" || true
  fi
  cleanup_incomplete
  exit "$code"
}
trap on_error ERR

kode_backup_authorize

[ -n "${KODE_BACKUP_ROOT:-}" ] || kode_fail "backup root is required"
[ -n "${KODE_OFFSITE_DIR:-}" ] || kode_fail "staging directory is required"
[ -n "${AGE_RECIPIENT:-}" ] || kode_fail "age recipient is required"
[ -n "${PGHOST:-}" ] && [ -n "${PGPORT:-}" ] && [ -n "${PGUSER:-}" ] && [ -n "${PGDATABASE:-}" ] || kode_fail "database connection settings are required"
[ -n "${PGPASSWORD:-}" ] || kode_fail "database password is required"
[ -n "${MC_CONFIG_DIR:-}" ] || kode_fail "MinIO client config is required"
[ -n "${MC_SOURCE_ALIAS:-}" ] || kode_fail "MinIO source alias is required"
[ -n "${KODE_PG_DOCKER_CONTAINER:-}" ] || kode_fail "database container is required"
export MC_CONFIG_DIR MC_SOURCE_ALIAS KODE_PG_DOCKER_CONTAINER

case "$KODE_PG_DOCKER_CONTAINER" in
  *supabase* | db | supabase-db)
    echo "refusing the old Supabase database service" >&2
    exit 2
    ;;
esac

STAMP="${KODE_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
case "$STAMP" in
  *[!A-Za-z0-9_-]*) echo "refusing an unsafe backup stamp" >&2; exit 2 ;;
esac
RUN="$KODE_BACKUP_ROOT/runs/$STAMP"
SET="$KODE_OFFSITE_DIR/sets/$STAMP"
remote=""
if [ -n "${KODE_RCLONE_REMOTE:-}" ]; then
  remote="${KODE_RCLONE_REMOTE}/sets/${STAMP}"
fi
if [ -e "$SET" ]; then
  echo "refusing to replace an existing backup set" >&2
  exit 2
fi
if [ -n "$remote" ] && rclone lsf "$remote" 2>/dev/null | grep -q .; then
  echo "refusing to replace an existing backup set" >&2
  exit 2
fi

mkdir -p "$RUN/objects" "$RUN/bin" "$SET"
set_state started

pgpass="$RUN/pgpass"
umask 077
{
  printf '%s:%s:%s:%s:%s\n' "127.0.0.1" "5432" "$PGDATABASE" "$PGUSER" "$PGPASSWORD"
  printf '%s:%s:%s:%s:%s\n' "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$PGPASSWORD"
} >"$pgpass"
chmod 600 "$pgpass"
docker exec -i "$KODE_PG_DOCKER_CONTAINER" sh -c 'umask 077; cat > /dev/shm/kode-backup.pgpass' <"$pgpass"
unset PGPASSWORD
export PGPASSFILE="$pgpass"

cat >"$RUN/bin/psql-via-docker" <<'EOF'
#!/bin/sh
exec docker exec -i \
  -e PGPASSFILE=/dev/shm/kode-backup.pgpass \
  -e PGOPTIONS \
  "$KODE_PG_DOCKER_CONTAINER" \
  psql "$@"
EOF
chmod 700 "$RUN/bin/psql-via-docker"
export KODE_PSQL_CMD="$RUN/bin/psql-via-docker"
export KODE_HOLDER_PGHOST=127.0.0.1
export KODE_HOLDER_PGPORT=5432

psql_at() {
  local database="$1"
  local sql="$2"
  "$KODE_PSQL_CMD" -h 127.0.0.1 -p 5432 -U "$PGUSER" -d "$database" \
    -v ON_ERROR_STOP=1 -X -A -t --no-psqlrc -c "$sql"
}

dump_version="$(docker exec "$KODE_PG_DOCKER_CONTAINER" pg_dump --version)"
case "$dump_version" in
  *" 17."*) ;;
  *)
    die 3 "refusing pg_dump client that is not PostgreSQL 17"
    ;;
esac
server_version="$(psql_at "$PGDATABASE" "SHOW server_version_num;")"
case "$server_version" in
  17*) ;;
  *)
    die 3 "refusing a database server that is not PostgreSQL 17"
    ;;
esac

role_row="$(psql_at "$PGDATABASE" "SELECT rolname || '|' || rolsuper || '|' || rolcreatedb || '|' || rolcreaterole || '|' || rolreplication || '|' || rolbypassrls FROM pg_roles WHERE rolname = current_user;")"
if [ "$role_row" != "kode_backup|false|false|false|false|false" ]; then
  die 3 "refusing a database role that is not the scoped kode_backup login"
fi
authid_privilege="$(psql_at "$PGDATABASE" "SELECT has_table_privilege(current_user, 'pg_authid', 'SELECT');")"
if [ "$authid_privilege" != "f" ]; then
  die 3 "refusing a backup role that can read password hashes"
fi
current_db="$(psql_at "$PGDATABASE" "SELECT current_database();")"
if [ "$current_db" != "$PGDATABASE" ]; then
  die 3 "refusing a connection that is not the requested database"
fi

unread="$(psql_at "$PGDATABASE" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%' AND NOT has_table_privilege(current_user, c.oid, 'SELECT');")"
if [ "$unread" != "0" ]; then
  die 3 "backup role cannot read every user table in ${PGDATABASE}"
fi

other_dbs="$(psql_at "$PGDATABASE" "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND datname <> current_database();")"
for other_db in $other_dbs; do
  readable="$(psql_at "$other_db" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%' AND has_table_privilege(current_user, c.oid, 'SELECT');")"
  if [ "$readable" != "0" ]; then
    die 3 "backup role can read user tables outside ${PGDATABASE}"
  fi
done

lo_count="$(psql_at "$PGDATABASE" "SELECT count(*) FROM pg_largeobject_metadata;")"
if [ "$lo_count" != "0" ]; then
  die 3 "large objects present (${lo_count}); refusing a dump that cannot read them"
fi

BUCKETS=(
  chat-images
  chat-attachments
  content-review-assets
  employee-documents
  kode-staging
  organization-branding
  profile-pictures
)
: >"$RUN/buckets.ndjson"
plain_bytes=0
object_count=0
for bucket in "${BUCKETS[@]}"; do
  list="$RUN/list-${bucket}.ndjson"
  if ! mc ls --recursive --json "${MC_SOURCE_ALIAS}/${bucket}" >"$list"; then
    die 4 "failed to list bucket ${bucket}"
  fi
  python3 - "$bucket" "$list" "$RUN/buckets.ndjson" <<'PY'
import json, sys
bucket, list_path, summary_path = sys.argv[1:]
count = 0
size = 0
with open(list_path, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        if item.get("type") not in (None, "file"):
            continue
        if not item.get("key"):
            continue
        count += 1
        size += int(item.get("size") or 0)
with open(summary_path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"name": bucket, "object_count": count, "plain_bytes": size}) + "\n")
PY
done
while read -r count size; do
  object_count=$((object_count + count))
  plain_bytes=$((plain_bytes + size))
done < <(python3 - "$RUN/buckets.ndjson" <<'PY'
import json, sys
total_count = 0
total_size = 0
for line in open(sys.argv[1], encoding="utf-8"):
    if line.strip():
        item = json.loads(line)
        total_count += int(item["object_count"])
        total_size += int(item["plain_bytes"])
print(total_count, total_size)
PY
)
# The process substitution above is bash-specific and fine on bash 3.2.
# Recompute with a file to stay compatible if the substitution was skipped.
if [ -z "${object_count:-}" ]; then
  object_count=0
  plain_bytes=0
fi

free_kb="$(df -Pk "$KODE_BACKUP_ROOT" | awk 'NR==2 {print $4}')"
free_bytes=$((free_kb * 1024))
overhead=$((object_count * 4096))
growth=$((plain_bytes / 3))
need=$((plain_bytes + overhead + growth + 5368709120))
remain=$((free_bytes - need))
if [ "$remain" -lt 21474836480 ]; then
  die 6 "refusing to start: free space after staging would be under 20 GiB"
fi

python3 "$SCRIPT_DIR/hold-snapshot.py" "$RUN" &
holder_pid=$!
ready=0
i=0
while [ "$i" -lt 300 ]; do
  if [ -f "$RUN/snapshot.ready" ]; then
    ready=1
    break
  fi
  if ! kill -0 "$holder_pid" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 0.1
done
if [ "$ready" != "1" ]; then
  die 4 "database snapshot was not exported"
fi
snapshot_id="$(tr -d '\n' < "$RUN/snapshot.id")"

nice -n 19 docker exec -e PGPASSFILE=/dev/shm/kode-backup.pgpass \
  "$KODE_PG_DOCKER_CONTAINER" \
  pg_dump -h 127.0.0.1 -p 5432 -U "$PGUSER" -d "$PGDATABASE" \
  --snapshot="$snapshot_id" -Fc --no-owner --no-privileges --no-large-objects \
  | nice -n 19 zstd -3 -T1 \
  | age -r "$AGE_RECIPIENT" -o "$RUN/postgres.dump.zst.age"
release_snapshot
set_state local_snapshot_completed

if [ -n "${KODE_CONFIG_LIST:-}" ]; then
  config_stage="$RUN/config-src"
  mkdir -p "$config_stage"
  while IFS= read -r config_file; do
    [ -n "$config_file" ] || continue
    cp "$config_file" "$config_stage/$(basename "$config_file")"
  done <"$KODE_CONFIG_LIST"
  tar -C "$config_stage" -cf - . | zstd -3 -T1 | age -r "$AGE_RECIPIENT" -o "$RUN/config.tar.zst.age"
  rm -rf "$config_stage"
  config_stage=""
fi

index_plain="$RUN/index.plain.ndjson"
: >"$index_plain"
for bucket in "${BUCKETS[@]}"; do
  python3 - "$bucket" "$RUN/list-${bucket}.ndjson" "$RUN/objects" "$index_plain" "$AGE_RECIPIENT" <<'PY'
import hashlib, json, os, subprocess, sys
bucket, list_path, objdir, index_path, recipient = sys.argv[1:]
with open(list_path, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        if item.get("type") not in (None, "file") or not item.get("key"):
            continue
        key = item["key"]
        cipher_name = hashlib.sha256(f"{bucket}\n{key}".encode()).hexdigest() + ".age"
        cipher_path = os.path.join(objdir, cipher_name)
        env = os.environ.copy()
        env["KODE_OBJECT_URL"] = f"{env['MC_SOURCE_ALIAS']}/{bucket}/{key}"
        env["KODE_AGE_RECIPIENT"] = recipient
        env["KODE_CIPHER_PATH"] = cipher_path
        proc = subprocess.run(
            ["bash", "-c", 'set -o pipefail; mc cat "$KODE_OBJECT_URL" | nice -n 19 zstd -3 -T1 | age -r "$KODE_AGE_RECIPIENT" -o "$KODE_CIPHER_PATH"'],
            check=False,
            env=env,
        )
        if proc.returncode != 0 or not os.path.isfile(cipher_path):
            raise SystemExit(f"encrypt failed for bucket {bucket}")
        digest = hashlib.sha256()
        size = 0
        with open(cipher_path, "rb") as cipher:
            while True:
                chunk = cipher.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
        record = {
            "bucket": bucket,
            "key": key,
            "size": int(item.get("size") or 0),
            "etag": item.get("etag"),
            "cipher": cipher_name,
            "cipher_bytes": size,
            "sha256": digest.hexdigest(),
        }
        with open(index_path, "a", encoding="utf-8") as index:
            index.write(json.dumps(record, separators=(",", ":")) + "\n")
PY
done
rm -f "$RUN"/list-*.ndjson

prev_stamp=""
prev_manifest=""
if [ -f "$KODE_BACKUP_ROOT/LATEST_OK" ]; then
  prev_stamp="$(tr -d '\n' < "$KODE_BACKUP_ROOT/LATEST_OK")"
  if [ -n "${KODE_RCLONE_REMOTE:-}" ] && [ -f "${KODE_RCLONE_REMOTE}/sets/${prev_stamp}/manifest.public.json" ]; then
    prev_manifest="${KODE_RCLONE_REMOTE}/sets/${prev_stamp}/manifest.public.json"
  elif [ -f "$KODE_OFFSITE_DIR/sets/${prev_stamp}/manifest.public.json" ]; then
    prev_manifest="$KODE_OFFSITE_DIR/sets/${prev_stamp}/manifest.public.json"
  fi
fi
python3 - "$RUN/references.ndjson" "$index_plain" "$RUN/consistency.ndjson" "$RUN/consistency.summary.json" "$prev_manifest" "$prev_stamp" <<'PY'
import hashlib, json, os, subprocess, sys
refs_path, index_path, detail_path, summary_path = sys.argv[1:5]
prev_manifest_path = sys.argv[5]
prev_stamp = sys.argv[6]
indexed = {}
with open(index_path, encoding="utf-8") as handle:
    for line in handle:
        if line.strip():
            item = json.loads(line)
            indexed[(item["bucket"], item["key"])] = item
counts = {
    "committed_references": 0, "missing": 0, "replaced": 0, "in_progress": 0,
    "unscoped": 0, "unparsed": 0, "stat_failed": 0,
    "recoverable_gaps": 0, "unrecoverable_gaps": 0,
}
prior_files = set()
if prev_manifest_path and os.path.isfile(prev_manifest_path):
    prior = json.loads(open(prev_manifest_path, encoding="utf-8").read())
    if prior.get("state") in {"valid", "degraded", "complete"}:
        prior_files = {item["name"] for item in prior.get("files", [])}

def cipher_name(bucket, key):
    digest = hashlib.sha256(f"{bucket}\n{key}".encode()).hexdigest()
    return f"objects/{digest}.age"

def note_gap(kind, bucket, key, relation):
    recoverable = cipher_name(bucket, key) in prior_files and bool(prev_stamp)
    counts["recoverable_gaps" if recoverable else "unrecoverable_gaps"] += 1
    details.append({
        "class": kind,
        "bucket": bucket,
        "key": key,
        "relation": relation,
        "recoverable_from": prev_stamp if recoverable else None,
    })
details = []
if os.path.exists(refs_path):
    with open(refs_path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            ref = json.loads(line)
            kind = ref.get("class")
            if kind == "unparsed":
                counts["unparsed"] += 1
                details.append({"class": "unparsed", "relation": ref.get("relation")})
                continue
            if kind == "in_progress":
                counts["in_progress"] += 1
                continue
            if kind != "committed":
                counts["unscoped"] += 1
                continue
            counts["committed_references"] += 1
            found = indexed.get((ref.get("bucket"), ref.get("key")))
            if found is None:
                counts["missing"] += 1
                note_gap("missing", ref.get("bucket"), ref.get("key"), ref.get("relation"))
for key, item in indexed.items():
    env = os.environ.copy()
    env["KODE_STAT_URL"] = f"{env['MC_SOURCE_ALIAS']}/{item['bucket']}/{item['key']}"
    proc = subprocess.run(["bash", "-c", 'mc stat --json "$KODE_STAT_URL"'], capture_output=True, text=True, env=env)
    etag = None
    if proc.returncode == 0:
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                stat = json.loads(line)
            except json.JSONDecodeError:
                continue
            if stat.get("etag"):
                etag = stat["etag"]
    if proc.returncode != 0:
        counts["stat_failed"] += 1
        details.append({"class": "stat_failed", "bucket": item["bucket"], "key": item["key"]})
        continue
    if etag and item.get("etag") and etag != item.get("etag"):
        counts["replaced"] += 1
        note_gap("replaced", item["bucket"], item["key"], "object_stat")
if counts["unrecoverable_gaps"]:
    recovery_class = "incomplete"
elif counts["recoverable_gaps"]:
    recovery_class = "degraded"
else:
    recovery_class = "valid"
counts["recovery_class"] = recovery_class
counts["recovers_with"] = prev_stamp if recovery_class == "degraded" else ""
with open(detail_path, "w", encoding="utf-8") as handle:
    for item in details:
        handle.write(json.dumps(item, separators=(",", ":")) + "\n")
with open(summary_path, "w", encoding="utf-8") as handle:
    json.dump(counts, handle)
PY

if [ -s "$index_plain" ]; then
  age -r "$AGE_RECIPIENT" -o "$RUN/index.ndjson.age" "$index_plain"
else
  printf '' | age -r "$AGE_RECIPIENT" -o "$RUN/index.ndjson.age"
fi
rm -f "$index_plain"
index_plain=""
age -r "$AGE_RECIPIENT" -o "$RUN/consistency.ndjson.age" "$RUN/consistency.ndjson"
rm -f "$RUN/consistency.ndjson" "$RUN/references.ndjson"
set_state encryption_completed

python3 - "$RUN" "$SET" "$STAMP" <<'PY'
import hashlib, json, pathlib, shutil, sys
run = pathlib.Path(sys.argv[1])
dest_root = pathlib.Path(sys.argv[2])
stamp = sys.argv[3]
wanted = ["postgres.dump.zst.age", "index.ndjson.age", "consistency.ndjson.age"]
if (run / "config.tar.zst.age").is_file():
    wanted.append("config.tar.zst.age")
files = []
for name in wanted:
    shutil.copy2(run / name, dest_root / name)
    files.append(name)
objects = run / "objects"
if objects.is_dir():
    for source in sorted(objects.glob("*.age")):
        target = dest_root / "objects" / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        files.append(str(target.relative_to(dest_root)))
entries = []
for name in files:
    path = dest_root / name
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    entries.append({"name": name, "bytes": size, "sha256": digest.hexdigest()})
buckets = []
for line in (run / "buckets.ndjson").read_text().splitlines():
    if line.strip():
        buckets.append(json.loads(line))
summary = json.loads((run / "consistency.summary.json").read_text())
manifest = {
    "recovery_set_id": stamp,
    "state": "checksum_pending",
    "recovery_class": summary.get("recovery_class"),
    "recovers_with": summary.get("recovers_with") or "",
    "buckets": buckets,
    "files": entries,
    "consistency": summary,
}
text = json.dumps(manifest, indent=2) + "\n"
lower = text.lower()
for forbidden in ("age-secret-key", "begin openssh private key", "database_password", "pgpassword"):
    if forbidden in lower:
        raise SystemExit("public manifest contains a secret marker")
tmp = dest_root / "manifest.public.json.tmp"
tmp.write_text(text)
tmp.replace(dest_root / "manifest.public.json")
PY
rm -f "$RUN/buckets.ndjson"
set_state offsite_transfer_completed

set +e
python3 - "$SET/manifest.public.json" <<'PY'
import hashlib, json, pathlib, sys
manifest_path = pathlib.Path(sys.argv[1])
base = manifest_path.parent
manifest = json.loads(manifest_path.read_text())
if manifest.get("state") != "checksum_pending":
    raise SystemExit("manifest was classified before checksum verification")
seen = {item["name"] for item in manifest["files"]}
for required in ("postgres.dump.zst.age", "index.ndjson.age", "consistency.ndjson.age"):
    if required not in seen:
        raise SystemExit("required ciphertext missing")
expected_buckets = {
    "chat-images", "chat-attachments", "content-review-assets",
    "employee-documents", "kode-staging", "organization-branding",
    "profile-pictures",
}
got = {item["name"] for item in manifest["buckets"]}
if got != expected_buckets:
    raise SystemExit("bucket inventory does not match the seven buckets")
total = 0
for item in manifest["buckets"]:
    total += int(item["object_count"])
cipher_files = [item for item in manifest["files"] if item["name"].startswith("objects/")]
if len(cipher_files) != total:
    raise SystemExit("object count does not match ciphertext files")
expected_names = set(seen)
expected_names.add("manifest.public.json")
for path in base.rglob("*"):
    if path.is_file() and str(path.relative_to(base)) not in expected_names:
        raise SystemExit("destination has a file that is not in the manifest")
for item in manifest["files"]:
    path = base / item["name"]
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    if digest.hexdigest() != item["sha256"] or size != int(item["bytes"]):
        raise SystemExit(f"checksum mismatch for {item['name']}")
consistency = manifest.get("consistency") or {}
for key in ("committed_references", "missing", "replaced", "in_progress", "unscoped", "unparsed", "stat_failed", "recovery_class", "recoverable_gaps", "unrecoverable_gaps"):
    if key not in consistency:
        raise SystemExit("consistency summary is incomplete")
if consistency["recovery_class"] not in {"valid", "degraded", "incomplete"}:
    raise SystemExit("unknown recovery class")
print(
    f"verified files={len(manifest['files'])} objects={total} "
    f"class={consistency['recovery_class']} missing_refs={consistency['missing']} "
    f"in_progress={consistency['in_progress']}"
)
PY
verify_status=$?
set -e
if [ "$verify_status" != "0" ]; then
  die 5 "integrity verification failed; previous LATEST_OK was left unchanged"
fi

mark_class() {
  python3 - "$1" "$2" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
manifest = json.loads(path.read_text())
manifest["state"] = sys.argv[2]
tmp = path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(manifest, indent=2) + "\n")
tmp.replace(path)
PY
}

recovery_class="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["consistency"]["recovery_class"])' "$SET/manifest.public.json")"
if [ "$recovery_class" = "incomplete" ]; then
  mark_class "$SET/manifest.public.json" incomplete
  set_state incomplete
  cleanup_incomplete
  echo "incomplete backup kept at $SET; previous fully recoverable set was left unchanged" >&2
  exit 7
fi

if [ -n "${KODE_RCLONE_REMOTE:-}" ]; then
  rclone copy "$SET" "$remote" --exclude "manifest.public.json" --checksum --immutable --transfers 1 --bwlimit 8M
  rclone check "$SET" "$remote" --download --one-way --exclude "manifest.public.json" --transfers 1
  echo "downloaded_ciphertext_ok"
  mark_class "$SET/manifest.public.json" "$recovery_class"
  rclone copy "$SET/manifest.public.json" "$remote" --checksum --immutable --transfers 1 --bwlimit 8M
  rm -rf "$SET" "$RUN/objects"
  rm -f "$RUN/postgres.dump.zst.age" "$RUN/config.tar.zst.age" "$RUN/index.ndjson.age" "$RUN/consistency.ndjson.age"
else
  mark_class "$SET/manifest.public.json" "$recovery_class"
fi
set_state integrity_verified
if [ "$recovery_class" = "valid" ]; then
  atomic_write "$KODE_BACKUP_ROOT/LATEST_OK" <<<"$STAMP"
else
  atomic_write "$KODE_BACKUP_ROOT/LATEST_DEGRADED" <<<"$STAMP"
fi
PUBLISHED=1
rm -f "$pgpass"
docker exec "$KODE_PG_DOCKER_CONTAINER" rm -f /dev/shm/kode-backup.pgpass >/dev/null 2>&1 || true
set_state complete
echo "$STAMP"
