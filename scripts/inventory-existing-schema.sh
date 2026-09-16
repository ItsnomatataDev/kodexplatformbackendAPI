
set -euo pipefail

SOURCE="$HOME/Desktop/devprojects/POSTGRES-SERVER/backups/public-schema-20260824T201843Z.sql"
OUTPUT="docs/database/existing-schema-inventory.txt"

if [ ! -f "$SOURCE" ]; then
  echo "Schema backup not found:"
  echo "$SOURCE"
  exit 1
fi

{
  echo "=== KODE PLATFORM — EXISTING POSTGRESQL SCHEMA INVENTORY ==="
  echo "Source: $SOURCE"
  echo "Generated: $(date)"
  echo

  echo "=== FILE ==="
  wc -l -c "$SOURCE"
  echo

  echo "=== TABLES ==="
  grep -E '^CREATE TABLE ' "$SOURCE" \
    | sed -E 's/^CREATE TABLE (IF NOT EXISTS )?//' \
    | sed 's/ (.*$//' \
    | sort

  echo
  echo "=== ENUMS ==="
  grep -E '^CREATE TYPE .* AS ENUM' "$SOURCE" \
    | sort

  echo
  echo "=== FUNCTIONS ==="
  grep -E '^CREATE FUNCTION |^CREATE OR REPLACE FUNCTION ' "$SOURCE" \
    | sed -E 's/^CREATE (OR REPLACE )?FUNCTION //' \
    | sed 's/(.*$//' \
    | sort

  echo
  echo "=== VIEWS ==="
  grep -E '^CREATE (OR REPLACE )?VIEW ' "$SOURCE" \
    | sort

  echo
  echo "=== TRIGGERS ==="
  grep -E '^CREATE TRIGGER ' "$SOURCE" \
    | sort

  echo
  echo "=== INDEXES ==="
  grep -E '^CREATE (UNIQUE )?INDEX ' "$SOURCE" \
    | sort

  echo
  echo "=== POLICIES ==="
  grep -E '^CREATE POLICY ' "$SOURCE" \
    | sort

  echo
  echo "=== EXTENSIONS ==="
  grep -E '^CREATE EXTENSION ' "$SOURCE" \
    | sort

} > "$OUTPUT"

echo "Inventory written to:"
echo "$OUTPUT"

echo
echo "=== SUMMARY ==="
echo "Tables:     $(grep -cE '^CREATE TABLE ' "$SOURCE" || true)"
echo "Enums:      $(grep -cE '^CREATE TYPE .* AS ENUM' "$SOURCE" || true)"
echo "Functions:  $(grep -cE '^CREATE (OR REPLACE )?FUNCTION ' "$SOURCE" || true)"
echo "Views:      $(grep -cE '^CREATE (OR REPLACE )?VIEW ' "$SOURCE" || true)"
echo "Triggers:   $(grep -cE '^CREATE TRIGGER ' "$SOURCE" || true)"
echo "Indexes:    $(grep -cE '^CREATE (UNIQUE )?INDEX ' "$SOURCE" || true)"
echo "Policies:   $(grep -cE '^CREATE POLICY ' "$SOURCE" || true)"
echo "Extensions: $(grep -cE '^CREATE EXTENSION ' "$SOURCE" || true)"
