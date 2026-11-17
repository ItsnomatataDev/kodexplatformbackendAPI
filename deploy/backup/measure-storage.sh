#!/usr/bin/env bash
# Read-only size check for the serving database and the live MinIO volume.
# An authorized root operator runs this on ubuntu-8gb-fsn1-2.
# It does not read object bodies, print credentials, or change Docker, Postgres, or MinIO.
set -euo pipefail
umask 077

if [ "${KODE_MEASURE_CONFIRM:-}" != "read-only" ]; then
  echo "refusing measurement without KODE_MEASURE_CONFIRM=read-only" >&2
  exit 2
fi

reject_path() {
  case "$1" in
    *itsnomatata* | *kode-restore-pgdata* | *kode-cdn-migration-rehearsal*)
      return 2
      ;;
  esac
  return 0
}

minio_volume="kode-platform-vps_kode_vps_minio_data"
postgres_volume="kode-platform-vps_kode_vps_postgres_data"
buckets="chat-images chat-attachments content-review-assets employee-documents kode-staging organization-branding profile-pictures"

if [ "${KODE_MEASURE_CHECK_ONLY:-0}" = "1" ]; then
  for bad in \
    /var/backups/itsnomatata \
    /var/lib/docker/volumes/kode-restore-pgdata/_data \
    /var/lib/docker/volumes/kode-cdn-migration-rehearsal-data/_data
  do
    if reject_path "$bad"; then
      echo "guard accepted $bad" >&2
      exit 1
    fi
  done
  for good in \
    "/var/lib/docker/volumes/${minio_volume}/_data" \
    "/var/lib/docker/volumes/${postgres_volume}/_data"
  do
    reject_path "$good" || {
      echo "guard rejected $good" >&2
      exit 1
    }
  done
  echo "measure_guards_ok"
  echo "minio_volume=${minio_volume}"
  echo "postgres_volume=${postgres_volume}"
  echo "buckets=${buckets}"
  exit 0
fi

host="$(hostname 2>/dev/null || echo unknown)"
if [ "$host" != "ubuntu-8gb-fsn1-2" ]; then
  echo "refusing measurement off the serving host" >&2
  exit 2
fi

volume_mount() {
  local name="$1"
  local mount
  mount="$(docker volume inspect -f '{{.Mountpoint}}' "$name")"
  reject_path "$mount" || {
    echo "refusing volume mount ${name}" >&2
    exit 2
  }
  case "$mount" in
    "/var/lib/docker/volumes/${name}/_data") ;;
    *)
      echo "refusing unexpected mount for ${name}" >&2
      exit 2
      ;;
  esac
  [ -d "$mount" ] || {
    echo "volume mount is missing for ${name}" >&2
    exit 2
  }
  printf '%s\n' "$mount"
}

minio_mount="$(volume_mount "$minio_volume")"
postgres_mount="$(volume_mount "$postgres_volume")"

echo "filesystem_bytes"
df -B1 /
echo "postgres_volume_bytes $(du -sb "$postgres_mount" | awk '{print $1}')"
echo "postgres_database_bytes $(docker exec kode-vps-postgres psql -U kode_staging -d kode_platform_staging -Atc "SELECT pg_database_size(current_database());")"

plain_bytes=0
object_count=0
for bucket in $buckets; do
  bucket_path="${minio_mount}/${bucket}"
  reject_path "$bucket_path" || exit 2
  if [ ! -d "$bucket_path" ]; then
    echo "stopping: live bucket directory is absent: ${bucket}" >&2
    exit 2
  fi
  bytes="$(du -sb "$bucket_path" | awk '{print $1}')"
  count="$(find "$bucket_path" -name xl.meta -type f | wc -l | tr -d ' ')"
  echo "bucket ${bucket} bytes=${bytes} xl_meta=${count}"
  plain_bytes=$((plain_bytes + bytes))
  object_count=$((object_count + count))
done

echo "minio_application_bytes ${plain_bytes}"
echo "minio_xl_meta_count ${object_count}"
python3 - "$plain_bytes" "$object_count" <<'PY'
import shutil, sys
plain = int(sys.argv[1])
count = int(sys.argv[2])
free = shutil.disk_usage("/").free
need = plain + plain // 3 + count * 4096 + 5 * 1024 * 1024 * 1024
remain = free - need
print(f"staging_need_bytes {need}")
print(f"free_after_staging_bytes {remain}")
if remain >= 20 * 1024 * 1024 * 1024:
    print("free_space_gate pass")
else:
    print("free_space_gate fail")
PY
