set -euo pipefail
umask 077

if [ "${KODE_ROLE_APPLY_CONFIRM:-}" != "serving-window" ]; then
  echo "refusing to create the backup role outside an approved window" >&2
  exit 2
fi
if [ -z "${KODE_BACKUP_PASSWORD:-}" ]; then
  echo "refusing to create the backup role without KODE_BACKUP_PASSWORD in the environment" >&2
  exit 2
fi
if [ "${KODE_PG_DOCKER_CONTAINER:-}" != "kode-vps-postgres" ]; then
  echo "refusing to create the backup role outside the serving container" >&2
  exit 2
fi

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
docker cp "$root/sql/kode_backup_role.sql" "$KODE_PG_DOCKER_CONTAINER:/tmp/kode_backup_role.sql"
printf '%s\n' "KODE_BACKUP_PASSWORD=${KODE_BACKUP_PASSWORD}" \
  | docker exec -i "$KODE_PG_DOCKER_CONTAINER" sh -c 'umask 077; cat > /dev/shm/role.env'
docker exec -i "$KODE_PG_DOCKER_CONTAINER" sh -c 'set -a; . /dev/shm/role.env; set +a; rm -f /dev/shm/role.env; psql -U kode_staging -d kode_platform_staging -v ON_ERROR_STOP=1 -f -' <<'SQL'
\getenv kode_backup_password KODE_BACKUP_PASSWORD
\ir /tmp/kode_backup_role.sql
SQL
docker exec "$KODE_PG_DOCKER_CONTAINER" rm -f /tmp/kode_backup_role.sql /dev/shm/role.env
echo "backup role applied"
