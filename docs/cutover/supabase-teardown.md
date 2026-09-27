# Hard cutover complete (Kode-only runtime)

## What changed
- Supabase JS client is **always offline** (no live network to Supabase)
- Kode feature flags default **ON** (`VITE_KODE_AUTH` only disables if set to `false`)
- Chat blocks, AI router, clients list/create, push persistence, signup/Google gated off Supabase
- Dashboard / notifications / chat keys already on Kode

## Point production FE at Kode

Kode API is deployed on the VPS at `/opt/kode-platform` (host network, port 3000).
Caddy on `api.tmctechsolutions.com` routes **all** HTTP(S) API traffic to Kode.
`meet.itsnomatata.com` still proxies to LiveKit.

1. Vercel project `itsnomatata-workspace` production env:
   - `VITE_KODE_API_URL=https://api.tmctechsolutions.com`
   - `VITE_KODE_AUTH=true`
2. Redeploy FE: `npx vercel --prod --project itsnomatata-workspace`
3. Smoke login → dashboard → boards → chat → tickets.

## Supabase teardown (done 2026-09-22)

On the VPS:
- Stopped and removed all Supabase app containers (auth, rest, db, storage, realtime, studio, minio, etc.)
- Wiped Supabase DB/storage volumes and `/opt/itsnomatata-api/stack/volumes/{db,storage,...}`
- Pruned unused Docker images (~9.3GB)
- Rewrote Caddy to Kode-only + LiveKit (no `/auth/v1` Kong routes)
- Left **`supabase-caddy` only** as the TLS reverse proxy (name is historical; no Supabase services)

Do **not** run `/opt/itsnomatata-api/stack/run.sh` or compose-up the supabase project.

Marker file on server: `/opt/itsnomatata-api/SUPABASE_REMOVED.md`

## Operator steps (passwords)
1. FE: keep `VITE_KODE_AUTH=true` and `VITE_KODE_API_URL` set. Supabase env vars are unused.
2. From **kode-platform** (not the FE repo), or Admin → **Remind password reset** on Codex.
3. Smoke login → dashboard → boards → chat → tickets.
