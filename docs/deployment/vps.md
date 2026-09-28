# VPS API deployment

## Incident and authoritative configuration

Use `docker-compose.vps.yml` with the VPS's existing, gitignored `.env.vps`.
Always pass BOTH `--env-file .env.vps` and `-f docker-compose.vps.yml`.
The first supplies Compose substitutions (including datastore credentials); the
service's `env_file` supplies API runtime variables. The service's explicit
`environment` entries override `env_file`, and both override Dockerfile ENV.
A shell HOST value does not replace the literal HOST entry in this Compose file.
Do not print rendered Compose JSON: it includes secrets.

The old tracked `HOST: 127.0.0.1` restored the failing bind every time the stack
was synchronized and recreated, overriding `.env.vps` changes. The operator
confirmed matching built/running image IDs, local health 200, public Caddy 502,
and recovery after changing to `0.0.0.0`. The authoritative bind is now
**HOST=0.0.0.0, PORT=3000, network_mode=host**. Host networking remains necessary
for existing PostgreSQL, Redis and MinIO loopback addresses. No datastore
addresses, credentials, runtime authorization or media diagnostics are changed.

The exact live Caddy upstream/network namespace is not in this repository.
A host Caddy using `127.0.0.1:3000` in the same namespace should work with a
loopback listener; therefore the reported behavior must not be generalized to
all host Caddy installations. Confirm the actual upstream and Caddy namespace
before the first rollout. The patch preserves the operator-tested wildcard bind.
Do not replace the live Caddy configuration with `deploy/Caddyfile.example`:
that example uses `api:3000` for a different, bridged production stack.

The Dockerfile already defaults HOST to 0.0.0.0. Server startup passes env.host
straight to the listener. Staging permits the wildcard bind; development still
requires loopback. `docker-compose.yml` contains only local development data
services and needs no API bind change. The generic production Compose example
uses a private bridge; its container wildcard bind is appropriate there too.

## Mandatory security prerequisite — before recreating the API

Wildcard binding under host networking listens on the VPS's public IPv4
interfaces too. Docker `EXPOSE`, absence of `ports`, and the container health
check do NOT protect TCP/3000. This patch alone does not install a firewall.
**Do not deploy until a persistent host/provider firewall denies untrusted direct
TCP/3000 while permitting the verified Caddy path.** Do not broadly allow the
public interface or all private address ranges to solve proxy connectivity.

`deploy/vps-api-guard.nft.example` is a narrowly scoped review template, not an
automatic firewall installer. Have the host firewall administrator merge it into
the existing persistent firewall configuration without flushing existing rules.
Its inet input chain drops TCP/3000 on IPv4 and IPv6 except loopback. If Caddy is
containerized, first add an exception scoped to its verified private bridge AND
stable source address, as shown in the template. Review recreation stability of
that bridge/address. Other firewall chains may still deny traffic accepted by
this chain. A provider firewall can add defense in depth but must not block the
legitimate Caddy-to-host path.

Inspect installed rules read-only (`sudo nft list ruleset`, or the host's actual
firewall tooling), confirm reboot persistence, and verify the allowed Caddy path.
From an independent external machine, check every public VPS address:

```sh
nc -vz -w 5 <VPS_PUBLIC_IPV4> 3000
# If the host has public IPv6, also:
nc -6 -vz -w 5 <VPS_PUBLIC_IPV6> 3000
```

These direct connections must fail while HTTPS remains reachable. Repeat after
deployment. Do not mistake local curl success for proof of external filtering.
No firewall, Caddy, or live-host changes are performed by this repository's
validation scripts.

## Reviewed deployment procedure

After completing the security prerequisite, run on the VPS from `/opt/kode-platform`.
Synchronize reviewed tracked files only; preserve `.env.vps`, certificates and
volumes. Do not copy a developer `.env` or use an rsync deletion that removes
runtime files. Save the previously reviewed Compose file outside the checkout.

```sh
cd /opt/kode-platform
# Before replacing the old deployment files:
cp docker-compose.vps.yml /opt/kode-platform-vps.rollback.yml
previous_image=$(docker inspect --format '{{.Image}}' kode-vps-api)
docker image tag "$previous_image" kode-platform-vps-api:rollback-network

# Now synchronize the reviewed tracked patch, preserving runtime secrets.
node scripts/deploy/validate-vps.mjs
# Equivalent: npm run validate:vps

docker compose --env-file .env.vps -f docker-compose.vps.yml build api
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --no-deps --force-recreate api

# Allow startup to complete, then require all checks below to pass.
node scripts/deploy/verify-vps.mjs
# Equivalent: npm run verify:vps
```

Only the API is recreated; no datastore containers or volumes are rebuilt or
removed. A successful build or Docker health status is insufficient. If startup
is still in progress, rerun verification after it settles; persistent failure is
a failed deployment. The verifier checks rendered configuration, running HOST
and PORT, local HTTP health, public HTTPS health, and the actual browser-origin
CORS preflight. It does not install firewall rules, check their persistence, or
prove denial from an external network. Those remain mandatory operator checks.

Manual equivalents and listener check:

```sh
docker exec kode-vps-api sh -c 'echo "HOST=$HOST PORT=$PORT"'
ss -lntp | grep ':3000'
curl --fail --max-time 10 -i http://127.0.0.1:3000/health/live
curl --fail --max-time 10 -i https://api.tmctechsolutions.com/health/live
curl --fail --max-time 10 -i -X OPTIONS \
  https://api.tmctechsolutions.com/health/live \
  -H 'Origin: https://codex.itsnomatata.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

Expect `HOST=0.0.0.0 PORT=3000`, an IPv4 wildcard listener on port 3000, HTTP 200
for BOTH health requests, and a successful preflight with
`Access-Control-Allow-Origin: https://codex.itsnomatata.com`, GET in allowed
methods and authorization/content-type in allowed headers. A sole
`127.0.0.1:3000` listener or runtime HOST=127.0.0.1 is a binding regression.
Local 200 plus public 502 is a failed proxy path even if Docker reports healthy.
Also inspect readiness (`/health/ready`) and normal authenticated application
requests when assessing datastore connectivity; liveness alone is not a DB probe.

## Rollback

Keep the port-3000 firewall protection in place. Roll back the image without
restoring the known-bad loopback binding. From the checkout with the reviewed
fixed Compose file:

```sh
cat > /tmp/kode-vps-rollback.yml <<'YAML'
services:
  api:
    image: kode-platform-vps-api:rollback-network
YAML
docker compose --env-file .env.vps -f docker-compose.vps.yml \
  -f /tmp/kode-vps-rollback.yml up -d --no-deps --no-build --pull never --force-recreate api
node scripts/deploy/verify-vps.mjs
```

Check the running image ID against the saved rollback image and repeat external
port denial checks. If configuration rollback is necessary, review the saved
Compose file and carry forward HOST=0.0.0.0/PORT=3000 and firewall prerequisites;
do not blindly restore the historical loopback override. Do not run compose down,
remove volumes, migrate databases or change secrets for this networking rollback.

## Regression checks

`npm test` includes `tests/vps-deployment.test.mjs`. Where Docker Compose is
available, it renders the real source file with synthetic conflicting env_file
and shell values, verifies the fixed result, then reinstates the old bind in a
temporary copy and proves validation fails. Other tests reject topology/port
changes, public datastore publishing, public 502/redirects and invalid CORS.
`npm run validate:vps` validates the actual rendered VPS file without outputting
credentials. Run it before every deployment; never substitute container-local
health for `npm run verify:vps` afterward.

This change stabilizes the intended API network configuration. It does not
establish or fix the separate video-stuttering root cause; retain media logging
and resume that investigation after public API health and CORS pass.
