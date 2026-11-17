#!/usr/bin/env bash
# Restore one complete encrypted set onto an isolated database and MinIO.
# Refuses the production host, production database, production port, and
# any MinIO endpoint that is not loopback. Does not accept production aliases.
set -euo pipefail
umask 077

if [ "${KODE_RESTORE_CONFIRM:-}" != "isolated" ]; then
  echo "refusing to restore without KODE_RESTORE_CONFIRM=isolated" >&2
  exit 2
fi

host="$(hostname 2>/dev/null || echo unknown)"
if [ "$host" = "ubuntu-8gb-fsn1-2" ]; then
  echo "refusing to restore on the production host" >&2
  exit 2
fi
case "${PGHOST:-}" in
  127.0.0.1 | localhost) ;;
  *)
    echo "refusing a restore database that is not loopback" >&2
    exit 2
    ;;
esac
if [ "${PGPORT:-}" = "5433" ]; then
  echo "refusing the production Postgres port" >&2
  exit 2
fi
case "${PGDATABASE:-}" in
  kode_platform_staging | postgres | template0 | template1)
    echo "refusing to restore over ${PGDATABASE}" >&2
    exit 2
    ;;
esac
case "${PGUSER:-}" in
  postgres | kode_staging | supabase_admin | authenticator | dashboard_user | kode_backup)
    echo "refusing restore user ${PGUSER}" >&2
    exit 2
    ;;
esac
case "${MC_RESTORE_ALIAS:-}" in
  kode | kode-vps | kode-backup-read | production | prod | src | minio)
    echo "refusing MinIO alias ${MC_RESTORE_ALIAS}" >&2
    exit 2
    ;;
esac
case "${KODE_PG_DOCKER_CONTAINER:-}" in
  "" | kode-vps-postgres | kode-vps-minio | kode-vps-api | *supabase*)
    echo "refusing restore container ${KODE_PG_DOCKER_CONTAINER:-empty}" >&2
    exit 2
    ;;
esac
case "${PGHOST}${PGPORT}${PGDATABASE}${MC_RESTORE_ALIAS}" in
  *128.140.124.44* | *api.tmctechsolutions.com* | *meet.itsnomatata.com*)
    echo "refusing a production address" >&2
    exit 2
    ;;
esac

: "${KODE_OFFSITE_DIR:?}"
: "${KODE_RESTORE_STAMP:?}"
: "${AGE_IDENTITY:?}"
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${PGPASSWORD:?}"
: "${MC_CONFIG_DIR:?}"
: "${MC_RESTORE_ALIAS:?}"
export MC_CONFIG_DIR MC_RESTORE_ALIAS

set +e
python3 - "$MC_CONFIG_DIR/config.json" "$MC_RESTORE_ALIAS" <<'PY'
import json, sys
from urllib.parse import urlparse
path, alias = sys.argv[1:]
config = json.loads(open(path, encoding="utf-8").read())
entry = (config.get("aliases") or {}).get(alias) or {}
url = entry.get("url") or ""
parsed = urlparse(url)
if parsed.hostname not in {"127.0.0.1", "localhost"}:
    print("refusing a MinIO restore endpoint that is not loopback", file=sys.stderr)
    raise SystemExit(2)
if "128.140.124.44" in url or "tmctechsolutions.com" in url or "itsnomatata.com" in url:
    print("refusing a production MinIO endpoint", file=sys.stderr)
    raise SystemExit(2)
PY
endpoint_status=$?
set -e
[ "$endpoint_status" = "0" ] || exit "$endpoint_status"

SET="$KODE_OFFSITE_DIR/sets/$KODE_RESTORE_STAMP"
test -f "$SET/manifest.public.json"
test -f "$SET/postgres.dump.zst.age"
test -f "$SET/index.ndjson.age"

restore_version="$(docker exec "$KODE_PG_DOCKER_CONTAINER" pg_restore --version)"
case "$restore_version" in
  *" 17."*) ;;
  *)
    echo "refusing pg_restore client that is not PostgreSQL 17" >&2
    exit 2
    ;;
esac

python3 - "$SET/manifest.public.json" <<'PY'
import hashlib, json, pathlib, sys
manifest_path = pathlib.Path(sys.argv[1])
base = manifest_path.parent
manifest = json.loads(manifest_path.read_text())
if manifest.get("state") not in {"valid", "degraded"}:
    raise SystemExit("refusing a set that is not a recoverable backup")
if manifest.get("state") == "degraded":
    print("degraded_set", (manifest.get("consistency") or {}).get("recovers_with", ""))
for item in manifest["files"]:
    digest = hashlib.sha256()
    size = 0
    with (base / item["name"]).open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    if digest.hexdigest() != item["sha256"] or size != int(item["bytes"]):
        raise SystemExit(f"checksum mismatch for {item['name']}")
print("ciphertext_ok", manifest["recovery_set_id"])
PY

recovery_state="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$SET/manifest.public.json")"
if [ "$recovery_state" = "degraded" ]; then
  if [ "${KODE_RESTORE_DEGRADED_CONFIRM:-}" != "content-version-unproven" ]; then
    echo "refusing a degraded set. A prior object under the same key does not prove those bytes match this database snapshot." >&2
    echo "Set KODE_RESTORE_DEGRADED_CONFIRM=content-version-unproven only to restore bytes for review. That is not operational acceptance." >&2
    exit 2
  fi
  degraded_restore=1
fi

pgpass="$(mktemp "${TMPDIR:-/tmp}/kode-restore-pgpass.XXXXXX")"
chmod 600 "$pgpass"
{
  printf '%s:%s:%s:%s:%s\n' "127.0.0.1" "5432" "$PGDATABASE" "$PGUSER" "$PGPASSWORD"
  printf '%s:%s:%s:%s:%s\n' "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$PGPASSWORD"
} >"$pgpass"
docker exec -i "$KODE_PG_DOCKER_CONTAINER" sh -c 'umask 077; cat > /dev/shm/kode-restore.pgpass' <"$pgpass"
rm -f "$pgpass"
unset PGPASSWORD

work="$(mktemp -d "${TMPDIR:-/tmp}/kode-restore.XXXXXX")"
cleanup() {
  rm -rf "$work"
  docker exec "$KODE_PG_DOCKER_CONTAINER" rm -f /dev/shm/kode-restore.pgpass >/dev/null 2>&1 || true
}
trap cleanup EXIT

age -d -i "$AGE_IDENTITY" "$SET/postgres.dump.zst.age" | zstd -d > "$work/dump"
docker exec -i -e PGPASSFILE=/dev/shm/kode-restore.pgpass \
  "$KODE_PG_DOCKER_CONTAINER" \
  pg_restore -h 127.0.0.1 -p 5432 -U "$PGUSER" -d "$PGDATABASE" \
  --no-owner --no-privileges --exit-on-error <"$work/dump"

age -d -i "$AGE_IDENTITY" "$SET/index.ndjson.age" > "$work/index.ndjson"
python3 - "$work/index.ndjson" "$SET/objects" <<'PY'
import json, os, subprocess, sys
index_path, object_dir = sys.argv[1:]
restored = 0
with open(index_path, encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        item = json.loads(line)
        cipher = os.path.join(object_dir, item["cipher"])
        env = os.environ.copy()
        env["KODE_CIPHER"] = cipher
        env["KODE_TARGET"] = f"{env['MC_RESTORE_ALIAS']}/{item['bucket']}/{item['key']}"
        proc = subprocess.run(
            ["bash", "-c", 'set -o pipefail; age -d -i "$AGE_IDENTITY" "$KODE_CIPHER" | zstd -d | mc pipe "$KODE_TARGET"'],
            check=False,
            env=env,
        )
        if proc.returncode != 0:
            raise SystemExit(f"restore failed for bucket {item['bucket']}")
        restored += 1
print(f"objects_restored={restored}")
PY
if [ "${degraded_restore:-0}" = "1" ]; then
  echo "degraded_bytes_restored_not_operational"
  echo "same key in the previous set does not prove content-version compatibility with this database snapshot"
  exit 8
fi
echo "valid_restore_bytes_ready"
