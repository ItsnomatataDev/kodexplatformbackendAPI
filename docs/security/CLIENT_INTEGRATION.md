# Security Control Center — Client Integration

How external apps, APIs, and services enroll and send security telemetry into Kode’s Security Control Center.

**Principle:** Only systems you explicitly register may send data. Kode does not scan arbitrary third-party infrastructure.

---

## Integration model (at a glance)

```text
1. Staff registers a Protected Project (optional) + Monitored System in SCC
2. Kode mints a one-time ingest token (kdesk_…)
3. Client stores the token as a secret (env / vault)
4. Client POSTs events or heartbeats to /api/security/ingest
5. Kode stores events → runs detection rules → may open alerts/incidents
6. Operators investigate in /admin/security
```

```text
Client app / API / worker
        │
        │  Authorization: Bearer kdesk_…
        │  POST /api/security/ingest
        ▼
Kode Security Control Center
        │
        ├── security.events
        ├── detection rules (Phase 2+)
        ├── security.alerts / security.incidents
        └── Dashboard / Investigations UI
```

---

## Who can integrate

| Client type | How they connect |
|-------------|------------------|
| **ITs No Matata Workspace** (FE) | Native: already uses Bearer user auth + `/api/security/*` staff APIs |
| **Kode Platform itself** | Native: auth middleware / login recorder emits events internally |
| **Harold / Media / other products** | Enroll as a **monitored system** + ingest token |
| **Customer / partner apps** | Same: enroll system under the org’s Security Control Center |
| **Infrastructure agents** (Phase 3+) | Same ingest contract; richer event types (`INFRA_*`) |

Clients never receive org-wide security read access via ingest tokens. Ingest tokens are **write-only** for that one system.

---

## Step-by-step enrollment

### 1. Open Security Control Center

Path: `/admin/security` → **Systems**

Requires: admin / IT / `security.manage*` permissions.

### 2. Create a monitored system

Fields:

| Field | Purpose |
|-------|---------|
| `name` | Human label (e.g. “Harold API”) |
| `slug` | Stable id (`harold-api`) |
| `kind` | `platform` \| `product` \| `external` \| `infrastructure` |
| `environment` | `development` \| `staging` \| `production` |
| `base_url` | Optional origin for documentation |

On create, Kode returns an **ingest token once**:

```text
kdesk_<opaque>
```

Store it immediately. It is hashed at rest; Kode cannot show the full token again (rotate to mint a new one).

### 3. (Optional) Attach to a protected project

Projects group assets across products:

```text
Project: Harold
  ├── Asset: Production API
  ├── Asset: PostgreSQL
  └── Monitored system: harold-api  (ingest)
```

### 4. Configure the client

```bash
KODE_SECURITY_INGEST_URL=https://api.example.com/api/security/ingest
KODE_SECURITY_INGEST_TOKEN=kdesk_…
```

Never commit the token. Rotate from **Systems → Rotate token** if leaked.

---

## Ingest API

### Endpoint

```http
POST /api/security/ingest
Authorization: Bearer kdesk_…
Content-Type: application/json
```

Alternate header:

```http
X-Kode-Ingest-Token: kdesk_…
```

No user session / CSRF required (machine-to-machine). Token must match an active, non-paused system.

### Heartbeat (health only)

```json
{
  "heartbeat": true,
  "health_status": "healthy"
}
```

`health_status`: `unknown` | `healthy` | `degraded` | `critical` | `offline`

### Security event

```json
{
  "event_type": "AUTH_FAILURE",
  "severity": "medium",
  "risk_score": 40,
  "successful": false,
  "ip_address": "203.0.113.10",
  "endpoint": "/v1/login",
  "attack_category": "authentication",
  "external_event_id": "evt-client-123",
  "title": "Failed login",
  "description": "Invalid credentials",
  "metadata": {
    "user_agent": "Mozilla/5.0…",
    "country": "ZA"
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `event_type` | Yes* | *unless `heartbeat: true` |
| `severity` | No | `info` \| `low` \| `medium` \| `high` \| `critical` |
| `risk_score` | No | 0–100+ integer |
| `successful` | No | boolean |
| `ip_address` | Recommended | Observed source IP (not “attacker identity”) |
| `endpoint` | Recommended | Path/route targeted |
| `attack_category` | No | e.g. `authentication`, `enumeration` |
| `external_event_id` | No | Idempotency key per system |
| `metadata` | No | **Never** send passwords, tokens, cookies, API keys |

Secrets in metadata are scrubbed server-side to `[redacted]`, but clients must not send them.

### Example (curl)

```bash
curl -sS -X POST "$KODE_SECURITY_INGEST_URL" \
  -H "Authorization: Bearer $KODE_SECURITY_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "AUTH_FAILURE",
    "severity": "medium",
    "risk_score": 45,
    "ip_address": "203.0.113.10",
    "endpoint": "/auth/login",
    "attack_category": "authentication"
  }'
```

### Example (Node)

```ts
await fetch(process.env.KODE_SECURITY_INGEST_URL!, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.KODE_SECURITY_INGEST_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    event_type: "RATE_LIMIT_VIOLATION",
    severity: "high",
    risk_score: 70,
    ip_address: clientIp,
    endpoint: req.path,
    attack_category: "abuse",
  }),
});
```

---

## Recommended event types (client → Kode)

Use stable uppercase names. Phase 2 detectors key off these patterns.

| Event type | When to emit |
|------------|--------------|
| `AUTH_FAILURE` | Failed login / bad password / unknown user |
| `AUTH_SUCCESS` | Successful authentication (optional, lower volume) |
| `AUTHZ_FAILURE` | 403 / permission denied on protected resource |
| `RATE_LIMIT_VIOLATION` | Client hit rate limit |
| `ENDPOINT_ENUMERATION` | Burst of 404s on admin/sensitive paths |
| `SUSPICIOUS_REQUEST` | WAF / anomaly flag (client-side judgment) |
| `INVALID_TOKEN` | Bad/expired bearer |
| `SESSION_REPLAY` | Refresh token reuse detected |
| `HONEYPOT_INTERACTION` | Prefer Kode-hosted decoys; clients can report own decoys |
| `API_ABUSE` | Scraping / bulk abuse |
| `ADMIN_ACTION` | Sensitive admin mutation (audit-style) |

---

## What clients do **not** get

- No read access to other orgs’ events via ingest token  
- No ability to change detection rules via ingest  
- No automatic “hack back” or outbound scanning  
- No storage of passwords / refresh tokens through ingest  

Staff investigation uses normal Kode login + Security Control Center permissions.

---

## Operational checklist for each client

1. [ ] System created under correct organization  
2. [ ] Ingest token in secrets manager  
3. [ ] Heartbeat every 1–5 minutes from production  
4. [ ] Auth failures + authz failures + rate limits wired  
5. [ ] `external_event_id` used for retries  
6. [ ] Token rotation runbook documented  
7. [ ] System paused in SCC during maintenance if needed  

---

## Phase 2 note (detection)

Clients only need to **emit good events**. Kode runs behavioral detection (brute force, enumeration, authz abuse, rate-limit abuse) on the event stream and opens alerts/incidents automatically when thresholds are crossed.

Clients should **not** re-implement correlation locally unless they want an extra layer; the SCC is the system of record for org-wide detection.
