#!/usr/bin/env bash
# One-shot Content Studio media migrate (Supabase → MinIO).
# Reads LEGACY_STORAGE_* from kode-platform/.env via dotenv — no manual export needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Clear empty shell overrides so .env values win.
unset SUPABASE_SERVICE_ROLE_KEY
unset LEGACY_STORAGE_SERVICE_ROLE_KEY

npm run migrate:content-studio-media -- --apply --allow-missing
