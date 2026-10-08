#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Guard against accidentally using a remote Docker context/daemon.
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
if [[ -n "${DOCKER_HOST:-}" || "$endpoint" != unix://* ]]; then
  echo 'Requires a local Unix-socket Docker context without DOCKER_HOST' >&2
  exit 1
fi
project="kode-cdn-test-$$"
compose=(docker compose --env-file /dev/null -p "$project" -f tests/media-cdn/compose.yml)
trap '"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1' EXIT
"${compose[@]}" build
"${compose[@]}" up -d --wait minio media-auth media-edge
"${compose[@]}" exec -T minio sh -eu -c '
mc alias set fixture http://localhost:9000 local-test-admin local-test-admin-password >/dev/null
mc admin user add fixture local-test-reader local-test-reader-password >/dev/null
cat > /tmp/reader.json <<POLICY
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::content-review-assets/.media/v1/*"]}]}
POLICY
mc admin policy create fixture media-reader /tmp/reader.json >/dev/null
mc admin policy attach fixture media-reader --user local-test-reader >/dev/null
'
"${compose[@]}" run --rm test
