#!/usr/bin/env bash
# Backup source and destination rules.
# Restore rules live in restore-drill.sh and are not relaxed here.

kode_fail() {
  echo "$1" >&2
  exit 2
}

kode_backup_authorize() {
  local mode="${KODE_BACKUP_MODE:-}"
  local check_only="${KODE_BACKUP_CHECK_ONLY:-0}"
  local host pghost pgport pguser pgdb alias remote stack container root pin_dir pin

  if [ "$check_only" = "1" ]; then
    host="${KODE_OBSERVED_HOST:-}"
    pghost="${KODE_OBSERVED_PGHOST:-}"
    pgport="${KODE_OBSERVED_PGPORT:-}"
    pguser="${KODE_OBSERVED_PGUSER:-}"
    pgdb="${KODE_OBSERVED_PGDATABASE:-}"
    alias="${KODE_OBSERVED_MC_ALIAS:-}"
    remote="${KODE_OBSERVED_RCLONE_REMOTE:-}"
    stack="${KODE_OBSERVED_STACK:-}"
    container="${KODE_OBSERVED_PG_CONTAINER:-}"
    root="${KODE_OBSERVED_BACKUP_ROOT:-}"
  else
    host="$(hostname 2>/dev/null || echo unknown)"
    pghost="${PGHOST:-}"
    pgport="${PGPORT:-}"
    pguser="${PGUSER:-}"
    pgdb="${PGDATABASE:-}"
    alias="${MC_SOURCE_ALIAS:-}"
    remote="${KODE_RCLONE_REMOTE:-}"
    stack="${KODE_SOURCE_STACK:-}"
    container="${KODE_PG_DOCKER_CONTAINER:-}"
    root="${KODE_BACKUP_ROOT:-}"
  fi

  case "$pguser" in
    postgres | supabase_admin | authenticator | dashboard_user | kode_staging)
      kode_fail "refusing database user ${pguser}"
      ;;
  esac
  case "$pgdb" in
    postgres | template0 | template1)
      kode_fail "refusing database ${pgdb}"
      ;;
  esac
  case "$stack" in
    *supabase* | *itsnomatata*)
      kode_fail "refusing the old Supabase stack"
      ;;
  esac
  case "$container" in
    *supabase* | db | supabase-db)
      kode_fail "refusing the old Supabase database service"
      ;;
  esac
  case "$remote" in
    *128.140.124.44* | *api.tmctechsolutions.com* | *meet.itsnomatata.com* | *supabase*)
      kode_fail "refusing a destination that points at the application host"
      ;;
  esac
  case "$root" in
    /var/backups/itsnomatata* | /opt/itsnomatata-api*)
      kode_fail "refusing to write into the historical stack"
      ;;
  esac

  if [ "$check_only" != "1" ] && [ -n "${AGE_IDENTITY:-}" ]; then
    kode_fail "refusing to back up while an age identity is available"
  fi
  if [ "$check_only" = "1" ] && [ "${KODE_OBSERVED_AGE_IDENTITY:-0}" = "1" ]; then
    kode_fail "refusing to back up while an age identity is available"
  fi

  case "$mode" in
    production)
      [ "$host" = "ubuntu-8gb-fsn1-2" ] || kode_fail "production backup requires hostname ubuntu-8gb-fsn1-2"
      [ "$pghost" = "127.0.0.1" ] || kode_fail "production backup requires the loopback database"
      [ "$pgport" = "5433" ] || kode_fail "production backup requires port 5433"
      [ "$pgdb" = "kode_platform_staging" ] || kode_fail "production backup requires kode_platform_staging"
      [ "$pguser" = "kode_backup" ] || kode_fail "production backup requires the kode_backup role"
      [ "$alias" = "kode-backup-read" ] || kode_fail "production backup requires the read-only MinIO alias"
      [ "$stack" = "kode-platform-vps" ] || kode_fail "production backup requires stack kode-platform-vps"
      [ "$container" = "kode-vps-postgres" ] || kode_fail "production backup requires container kode-vps-postgres"
      [ "$root" = "/var/backups/kode-platform" ] || kode_fail "production backup root must be /var/backups/kode-platform"
      [ -n "$remote" ] || kode_fail "production backup requires an off-site destination"
      case "$remote" in
        *:*) ;;
        *) kode_fail "production destination must be an rclone remote" ;;
      esac
      case "$remote" in
        /* | ./*) kode_fail "production destination must not be a local path" ;;
      esac
      if [ "$check_only" = "1" ]; then
        pin_dir="${KODE_BACKUP_PIN_DIR:-}"
      else
        pin_dir="/etc/kode-backup"
      fi
      [ -n "$pin_dir" ] && [ -f "$pin_dir/destination.pin" ] || kode_fail "production destination pin is missing"
      pin="$(tr -d '\n' < "$pin_dir/destination.pin")"
      [ "$pin" = "$remote" ] || kode_fail "destination does not match the pinned remote"
      ;;
    drill)
      [ "$host" != "ubuntu-8gb-fsn1-2" ] || kode_fail "refusing to run a drill backup on the production host"
      case "$pghost" in
        127.0.0.1 | localhost) ;;
        *) kode_fail "drill backup requires a loopback database" ;;
      esac
      [ "$pgport" != "5433" ] || kode_fail "refusing the production database port"
      [ "$pgdb" != "kode_platform_staging" ] || kode_fail "refusing the production database name"
      [ "$pguser" = "kode_backup" ] || kode_fail "drill backup requires the kode_backup role"
      case "$alias" in
        "" | kode | kode-vps | production | prod | kode-backup-read)
          kode_fail "refusing MinIO alias ${alias:-empty}"
          ;;
      esac
      case "$container" in
        "" | kode-vps-postgres | kode-vps-minio | kode-vps-api)
          kode_fail "refusing database container ${container:-empty}"
          ;;
      esac
      case "$root" in
        /tmp/* | "${TMPDIR:-/tmp}"/*) ;;
        *) kode_fail "drill backup root must stay under temporary storage" ;;
      esac
      if [ -z "$remote" ] && [ "${KODE_BACKUP_ALLOW_LOCAL_OFFSITE:-0}" != "1" ]; then
        kode_fail "refusing to treat a local directory as the off-site copy"
      fi
      if [ "${KODE_BACKUP_ALLOW_LOCAL_OFFSITE:-0}" = "1" ]; then
        case "${KODE_OFFSITE_DIR:-}" in
          /tmp/* | "${TMPDIR:-/tmp}"/*) ;;
          *) kode_fail "local drill destination must stay under temporary storage" ;;
        esac
      fi
      ;;
    *)
      kode_fail "KODE_BACKUP_MODE must be production or drill"
      ;;
  esac

  if [ "$check_only" = "1" ]; then
    echo "source_authorized"
    exit 0
  fi
}
