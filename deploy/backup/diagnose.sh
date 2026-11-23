set -euo pipefail
umask 077

report_file() {
  local label="$1"
  local path="$2"
  if [ ! -e "$path" ]; then
    printf '%s present=no\n' "$label"
    return
  fi
  local mode bytes
  mode="$(stat -f '%Lp' "$path" 2>/dev/null || stat -c '%a' "$path")"
  bytes="$(wc -c < "$path" | tr -d ' ')"
  printf '%s present=yes mode=%s bytes=%s\n' "$label" "$mode" "$bytes"
}

report_file destination_pin "${KODE_BACKUP_PIN_FILE:-/etc/kode-backup/destination.pin}"
report_file age_recipient "${KODE_AGE_RECIPIENT_FILE:-/etc/kode-backup/age.recipient}"
report_file backup_env "${KODE_DIAG_ENV_FILE:-/etc/kode-backup/backup.env}"

env_file="${KODE_DIAG_ENV_FILE:-/etc/kode-backup/backup.env}"
if [ -f "$env_file" ]; then
  names="$(awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { printf "%s ", $1 }' "$env_file")"
  printf 'env_names=%s\n' "$names"
  if grep -q "AGE-SECRET-KEY" "$env_file"; then
    echo "age_private_key=present_remove_it"
  else
    echo "age_private_key=absent"
  fi
else
  echo "env_names="
  echo "age_private_key=unknown"
fi

recipient_file="${KODE_AGE_RECIPIENT_FILE:-/etc/kode-backup/age.recipient}"
if [ -f "$recipient_file" ] && grep -q "AGE-SECRET-KEY" "$recipient_file"; then
  echo "recipient_file=contains_private_key"
else
  echo "recipient_file=no_private_key"
fi
