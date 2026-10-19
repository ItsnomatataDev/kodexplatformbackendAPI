#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
if [[ -n "${DOCKER_HOST:-}" || "$endpoint" != unix://* ]]; then
  echo 'Requires a local Unix-socket Docker context without DOCKER_HOST' >&2
  exit 1
fi
project="kode-cdn-test-$$"
compose=(docker compose --env-file /dev/null -p "$project" -f tests/media-cdn/compose.yml)
trap '"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1' EXIT
"${compose[@]}" build
"${compose[@]}" up -d --wait minio media-auth media-edge postgres
"${compose[@]}" exec -T minio sh -eu -c '
mc alias set fixture http://localhost:9000 local-test-admin local-test-admin-password >/dev/null
mc admin user add fixture local-test-worker local-test-worker-password >/dev/null
mc admin policy create fixture media-worker /policies/media-worker.json >/dev/null
mc admin policy attach fixture media-worker --user local-test-worker >/dev/null
mc admin user add fixture local-test-reader local-test-reader-password >/dev/null
cat > /tmp/reader.json <<POLICY
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::content-review-assets/.media/v1/*","arn:aws:s3:::content-review-assets/.media/v2/*"]}]}
POLICY
mc admin policy create fixture media-reader /tmp/reader.json >/dev/null
mc admin policy attach fixture media-reader --user local-test-reader >/dev/null
'
"${compose[@]}" run --rm test

logfile=$(mktemp)
"${compose[@]}" logs --no-log-prefix media-edge > "$logfile"
if grep -Eq 'X-Amz-|/media/v[12]/|Signature=' "$logfile"; then
  rm -f "$logfile"
  echo 'Unsafe edge logging detected' >&2
  exit 1
fi

if ! awk '$1 == 403 { seen=1; if ($NF != "-") bad=1 } END { exit (!seen || bad) }' "$logfile"; then
  rm -f "$logfile"
  echo 'Rejected requests unexpectedly reached an upstream' >&2
  exit 1
fi
rm -f "$logfile"
"${compose[@]}" run --rm --no-deps job-test
edge_address=$("${compose[@]}" port media-edge 8080)
MEDIA_TEST_EDGE="http://$edge_address" node tests/media-cdn/browser/verify.mjs
"${compose[@]}" stop media-auth >/dev/null
"${compose[@]}" run --rm -e TEST_PHASE=auth-outage --no-deps test
