# Security Control Center — Architecture Plan

**Status:** Phase 1 in progress  
**Phase 01 enforcement diagram:** [`PHASE_01_ENFORCEMENT.md`](./PHASE_01_ENFORCEMENT.md)  
**Principle:** Additive module inside Kode. Observe → Detect → Correlate → Investigate → Contain → Recover → Learn.  
**Never:** hack-back, malware, unauthorized scanning, credential theft, or destructive auto-containment.

This document replaces the bolt-on “Cyber Desk / Systems tab on Security Center” approach with a proper **Security Control Center** product surface, while **reusing** existing `security.*` schema, `/api/security` routes, and FE components where they already fit.

---

## 1. Existing architecture discovered

| Layer | Finding |
|-------|---------|
| Backend entry | `src/app.ts` — global security headers → CORS → requestId → client IP → body limit → CSRF → rate limiter inject → routes |
| API mount | Bearer-authenticated `/api` includes `/api/security`; public ingest at `/api/security/ingest` |
| Domain store | `src/security/postgres-store.ts` + `src/routes/security.ts` |
| Migrations | `0041_security_center.sql` (core), `0047_cyber_desk.sql` (monitored systems, ingest tokens, detection rules) |
| FE | Single-page Cyber Desk at `/it/security` (tabs); Kode client `lib/kode/security.ts` |
| Parallel domain | `it.*` monitors/alerts — **do not merge**; Control Center owns `security.*` |

Kode remains the foundation. The Control Center is another org-scoped product module.

---

## 2. Existing auth architecture

- Access: Bearer JWT with `sessionId`; refresh via HttpOnly `kode_refresh` + CSRF
- Cookies: `kode_refresh` (HttpOnly `/auth`), `kode_csrf` (readable `/`)
- Login rate limits: IP + email (email counted on failed password only)
- Auth domain events: `publishAuthEvent` → structured logs only (**does not** write `security.events` today)
- Separate tables: `identity.sessions` (auth) vs `security.sessions` (telemetry)

---

## 3. Existing authorization architecture

- Org-scoped `AuthContext` from membership; client org IDs rejected
- `hasPermission(permissions, 'security.manage')` with nested JSON / `"*"`
- Security gate today: `isSecurityStaff` = admin role **or** `role_key === 'it'` **or** `security.manage`
- `security.manage` is referenced but **never seeded** in role permissions
- No granular `security.view` / `security.investigate` / `security.contain` yet

---

## 4. Organization / tenant model

- One active membership → one `organizationId` from server context
- All security store queries filter `organization_id = $1`
- Seeded monitored systems (0047) limited to orgs matching `%no matata%`

---

## 5. Database structure relevant to security

**Present (`security` schema):**  
`sessions`, `devices`, `ip_reputation`, `blocklist`, `events`, `alerts`, `incidents`, `login_verifications`, `monitored_systems`, `ingest_tokens`, `detection_rules`

**Gaps for Control Center Phase 1:**  
`projects`, `assets`, `incident_events` (proper junction), `audit_log`, `honeypots`, `containment_actions`, expanded incident statuses, permission seeds, auth→event emission

**Not security assets:** `stock.assets` (inventory).

---

## 6. Logging / observability

- Pino request logs + `X-Request-Id`
- Auth domain events → logs only
- No append-only security audit table yet
- Redis used for rate limits / chat — **not** for security fan-out (acceptable for Phase 1)

---

## 7. Routes / navigation (current)

| Path | Role |
|------|------|
| `/it/security` | Canonical FE Cyber Desk |
| `/admin/security-center` | Redirect → `/it/security` |
| `/security/verify-login` | End-user step-up (keep) |
| `/api/security/*` | Staff APIs |
| `/api/security/ingest` | Token ingest |

Target Control Center: **`/admin/security`** (+ nested routes). Keep `/it/security` as alias redirect.

---

## 8. Reusable UI components

Reuse from `features/security-center/components/*`:  
`shared.tsx` (Section/Empty/Skeleton), overview cards, feed, IP tabs, alerts/incidents, blocklist, systems desk, maps.

Rebuild **shell only**: layout + URL routes + naming (“Security Control Center”), empty states with real API zeros (no mock activity).

---

## 9. Where Control Center integrates

```
Auth / rate-limit / CSRF / ingest
        ↓
security.recordEvent()  (new clean emitter)
        ↓
security.events → detection_rules → alerts / incidents
        ↓
/api/security/* (staff, org-scoped)
        ↓
/admin/security (FE Control Center)
```

Monitored systems remain the “protected project / product” enrollment path; Phase 1 adds explicit `security.projects` + `security.assets` and links systems optionally.

---

## 10. Proposed Phase 1 database schema (additive)

Migration: `0048_security_control_center.sql`

| Table | Purpose |
|-------|---------|
| `security.projects` | Protected projects (multi-product / external) |
| `security.assets` | Asset inventory under a project |
| `security.incident_events` | Event ↔ incident timeline junction |
| `security.audit_log` | Append-only investigator/config actions |
| `security.honeypots` | Authorized decoy endpoints |
| `security.containment_actions` | Explicit, auditable containment records |

Alters:

- `monitored_systems.project_id` nullable FK
- `events.project_id`, `events.asset_id`, `events.request_id`, `events.http_status` (nullable)
- Incident status CHECK expand: `open`, `investigating`, `contained`, `resolved`, `false_positive`
- Alert status: keep `open` (= new), add `investigating` if missing
- Seed nested permissions for `admin` + `it`:

```json
"security": {
  "view": true,
  "investigate": true,
  "manage_assets": true,
  "manage_rules": true,
  "manage_honeypots": true,
  "contain": true,
  "manage_configuration": true,
  "audit": true,
  "manage": true
}
```

---

## 11. Proposed API routes (Phase 1)

Existing routes kept. Additive:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/security/control-center` | Dashboard aggregates (real counts, 24h window) |
| GET | `/api/security/investigations` | Query by IP / user / event type / time |
| GET | `/api/security/investigations/ip/:ip` | Observed-source dossier (not “attacker identity”) |
| GET/POST | `/api/security/projects` | Protected projects |
| GET/POST/PATCH | `/api/security/assets` | Asset registry |
| GET | `/api/security/incidents/:id` | Incident + timeline |
| GET | `/api/security/audit` | Audit log (permission: `security.audit`) |
| GET/POST | `/api/security/honeypots` | Honeypot registry |
| POST | `/api/security/honeypots/:id/trip` | Internal trip recorder (or public decoy handler) |
| POST | `/api/security/containment` | Record containment (block IP reuses blocklist) |
| GET | `/api/security/rules` | List detection rules |

Public decoy (safe): registered honeypot path under `/api/security/decoy/:slug` — records event only, returns generic 404/empty.

All staff routes: auth from server context; org from membership; least-privilege permission checks.

---

## 12. Proposed frontend routes

| Path | Page |
|------|------|
| `/admin/security` | Dashboard (posture + real summary) |
| `/admin/security/investigations` | Investigate by IP / filters |
| `/admin/security/events` | Live feed (reuse SecurityFeed) |
| `/admin/security/incidents` | Incidents |
| `/admin/security/alerts` | Alerts |
| `/admin/security/assets` | Projects + assets |
| `/admin/security/systems` | Monitored systems / ingest |
| `/admin/security/containment` | Blocklist + containment |
| `/admin/security/learn` | Knowledge Center (Phase 1: fundamentals stub content) |
| `/it/security`, `/admin/security-center` | Redirect → `/admin/security` |

Sidebar label: **Security Control Center** → `/admin/security`.

---

## 13. Security risks discovered during inspection

1. Auth failures do not create `security.events` → blind dashboard until ingest/manual logs  
2. Blocklist not consulted at login → containment incomplete  
3. `security.manage` never seeded → only admin/`it` role keys work in practice  
4. No Security Center API tests → regressions likely  
5. Parallel `it.*` vs `security.*` could confuse operators if UIs merge carelessly  
6. Client-posted `/api/security/events` (any org member) needs strict scrubbing of secrets in metadata  
7. Ingest tokens are high-value secrets — rotate/audit carefully  

---

## 14. Files that need modification

**Backend:**  
`src/app.ts`, `src/routes/security.ts`, `src/security/postgres-store.ts`, `src/products/staff.ts`, `src/auth/login.ts` (or events publisher), `src/auth/routes.ts` (optional), permissions seed migration

**Frontend:**  
`AppRouter.tsx`, `Sidebar.tsx`, `AppDocumentTitle.tsx`, `itOfficeAccess.ts`, `lib/kode/security.ts`, `features/security-center/*` (shell rebuild; keep tab components)

---

## 15. Files newly created

- `docs/security/SECURITY_CONTROL_CENTER_PLAN.md` (this file)
- `migrations/0048_security_control_center.sql`
- `src/security/recorder.ts`
- `src/security/permissions.ts` (granular helpers)
- `tests/security-control-center.test.ts`
- FE: `SecurityControlCenterLayout.tsx`, dashboard / investigations / learn / assets pages
- `docs/security/learn/*.md` content consumed by learn page (fundamentals first)

---

## 16. Tests to add (Phase 1)

1. Unauthenticated → 401 on `/api/security/control-center`  
2. Authenticated non-staff → 403 `SECURITY_ADMIN_REQUIRED`  
3. Org A cannot read Org B events / investigations / assets  
4. Event POST rejects / scrubs password, token, refresh_token fields in metadata  
5. Containment (block IP) writes `security.audit_log` + `containment_actions`  
6. Honeypot trip creates high-severity event  
7. Incident detail returns linked timeline events  
8. Detection rule evaluation still fires on ingest (regression)

---

## Implementation phases (reminder)

| Phase | Scope |
|-------|--------|
| **1** | Schema + recorder + control-center APIs + FE shell + permissions + audit + tests |
| **2** | Behavioral detection (brute force, enumeration, authz abuse, rate-limit, honeypot) + client integration contract |
| **3** | Infra telemetry (VPS/Docker/Postgres/Redis) for enrolled assets |
| **4** | Endpoint/EDR-style telemetry (authorized hosts only) |
| **5** | Threat intel / IP reputation enrichment pipeline |
| **6** | Correlation / security graph views |
| **7** | Nomatata Brain as **assistant only** (never authoritative containment) |

**Client integration guide:** [`docs/security/CLIENT_INTEGRATION.md`](./CLIENT_INTEGRATION.md)

### Phase 2 scope

1. Windowed behavioral detectors over `security.events` (`src/security/detection.ts`)
2. Seeded rules: `AUTH_BRUTE_FORCE`, `ENDPOINT_ENUMERATION`, `AUTHZ_ABUSE`, `RATE_LIMIT_ABUSE`, `HONEYPOT_TRIP`
3. Detectors run after ingest + internal `recordSecurityEvent` / `logEvent`
4. Alerts use “observed source” wording; no auto block (containment stays human/explicit)
5. Document how clients enroll systems and POST `/api/security/ingest`

### Phase 2 acceptance

- [x] Client integration doc published
- [x] Behavioral detector module + migration `0049`
- [x] Wired into recorder + ingest path
- [ ] Detector unit/integration tests
- [ ] Rules visible in SCC `/api/security/rules`
---

## Phase 1 acceptance criteria

- [x] Migration applies cleanly (`0048_security_control_center.sql`)
- [x] Dashboard shows **real** counts or honest empty state (`/admin/security`)
- [x] `/admin/security` is the primary UI; Cyber Desk naming retired
- [x] Failed logins (when org-resolvable) appear as security events
- [x] Investigation by IP shows “Observed source” wording
- [x] Audit log appends on block/unblock and asset create
- [x] New security tests pass; existing auth tests still pass
- [x] No mock attack counts or fake IPs in UI

**Phase 1 shipped (2026-09-22):** schema + recorder + control-center/investigation/projects/assets/audit/honeypot/containment APIs + FE Control Center shell + auth event emission + tests.
