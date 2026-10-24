# Security IP investigation: proposed implementation plan

Prepared 5 October 2026. Status: planning only. No application code, frontend code, database schema, or VPS configuration was changed for this review.

## Intended outcome

An authorized investigator enters an IPv4 or IPv6 address and can answer:

1. What network does this address belong to, and how current is that information?
2. What activity has this source produced in our organization?
3. Why is that activity suspicious, and what evidence supports the assessment?
4. Which verified accounts, sessions, projects, and assets are associated with the activity?
5. What response action was taken, and where is it actually enforced?

The initial scope is Kode's own application and registered monitored systems. An arbitrary public IP can also be enriched, but it must show "no activity observed in this organization" when we have no internal evidence. No network probing is needed for this feature.

## Current implementation and gaps

The local frontend page is `ITsNomatataWorkSpace/src/features/security-center/pages/SecurityInvestigationsPage.tsx`, imported by the active router. It calls `GET /api/security/investigations/ip/:ip`. That route requires `security.investigate` and scopes the store queries to the authenticated organization. The result already includes first/last seen, event/failure totals, top targeted routes, cached network information, and related incidents. These are useful foundations.

The review inspected local code, not an authenticated deployed browser session. The findings below are code findings; they do not establish the state of controls configured separately on the VPS or a client's network.

| Finding | Current code | Required improvement |
| --- | --- | --- |
| Lookup accepts any nonempty text and compares IPs as exact text | `src/routes/security.ts:240`, `src/security/postgres-store.ts:1361` | Strict address validation and canonical matching, especially IPv6 and IPv4-mapped addresses. |
| Private-address filtering is an incomplete regular expression | `src/routes/security.ts:29` | Classify private, loopback, link-local, reserved, documentation, multicast, and carrier-grade NAT ranges; public-provider calls only for eligible public addresses. |
| Lookup reads cached enrichment; it does not obtain new intelligence | `investigateByIp` | Explicit enrichment availability, freshness, refresh action, and provider status. |
| Enrichment failures can become successful-looking records | `src/routes/security.ts:813`, `src/security/postgres-store.ts:796` | Validate HTTP and provider payload errors, impose a timeout, and stamp successful enrichment only after valid data arrives. |
| Enrichment sets `last_seen_at = NOW()` even without a new event | `enrichIp` | Keep actual observed activity timestamps separate from lookup/fetch timestamps. |
| Enrichment accepts caller-supplied provider facts, risk, and counts | `/enrich-ip`, `enrichIp` | Provider facts come from backend adapters; analyst notes have separate provenance. Counts and internal risk come from recorded events. |
| Reputation rows are not maintained by the core recorder or detector | `src/security/recorder.ts`, `src/security/detection.ts` | Reliable aggregates and a defined, versioned risk assessment. A default zero is not proof of a clean IP. |
| Failed logins for unknown accounts are not persisted in organization security events | `src/auth/login.ts` | Capture relevant anonymous activity under a verified organization context or separate platform scope. |
| Broad authorization/rate-limit failures are logged but not centrally emitted as security events | `src/middleware/error-handler.ts` | Normalize and record security-relevant request outcomes with deduplication. |
| Blocklist writes exist, but no request-time blocklist enforcement was found in this application | `blockIp`, `src/app.ts`, request middleware | Implement and test enforcement; describe any external enforcement separately and require acknowledgment. |
| Some blocked indicators ignore expiry | `listHighRiskIps`, summary block counts | Share one active-block predicate: not unblocked and not expired. |
| Block write, containment history, and audit are separate writes | `/blocklist`, `recordContainment` | Commit policy state and audit atomically; external application requires a durable acknowledgment workflow. |
| Investigation has no event timeline, project/time filters, risk explanation, or containment status | Current route and frontend response type | Add bounded, filterable evidence and clear action state. |
| UI can request twice on submit and accept stale responses | Page `onSubmit` plus URL-change effect | One request trigger; cancel or ignore previous requests when the search changes. |
| `tests/security-control-center.test.ts` is not listed in the regular test command | `package.json` | Include the relevant security contract/permission tests in required checks. |

## Required product behavior

### Evidence and activity

Show a time-filtered summary and a paginated event timeline with timestamp, source system, project/asset, event type, severity, route, HTTP status, request ID, and verified user/session references when available. Include successful and failed authentications, authorization failures, rate-limit events, scanning/enumeration detections, honeypot triggers, and existing alerts/incidents.

Default to the last 24 hours, offer 7 and 30 days, and permit a bounded custom range. Report all-time first/last observed separately from counts for the selected period. Store timestamps in UTC; display them with an explicit timezone, Africa/Harare by default.

Add `ip_address` to the existing strict event-list filter allowlist rather than issuing an unsupported filter. Reuse its pagination and project/integration filters. Distinguish an account targeted by a failed login from a verified account that actually authenticated from an IP.

### Explainable risk

Reuse the existing brute-force, endpoint-enumeration, authorization-abuse, rate-limit, and honeypot detectors. Return the triggered rule, counts, time window, threshold, and supporting event IDs. Use a bounded 0–100 local score with a versioned calculation, evidence coverage, and evaluation time; calibrate thresholds with real event data before setting automated action thresholds.

Display internal behavioral assessment and external reputation as separate inputs. A provider's score is not our application's incident verdict. Use an explicit unknown state when evidence or a provider result is missing. Initial automatic behavior creates deduplicated alerts; blocking remains an investigator action until its rules and recovery path have been proven.

### Network and reputation information

Keep approximate country/region/city, ASN, and network provider. Add network usage type and reported-abuse information when supported. VPN/proxy/Tor/hosting indicators must be nullable and name their provider; unsupported or unavailable does not mean false.

The existing ipapi provider can remain the first geolocation adapter while its error handling is corrected. Its documentation confirms that some error payloads arrive with HTTP 200, which the current handler does not check. [ipapi API errors](https://ipapi.co/api/#errors)

Recommend one initial reputation adapter, AbuseIPDB's check endpoint, because it supplies report counts, report recency, an abuse confidence score, and network usage information for IPv4/IPv6. It requires a backend API key and has quotas. Choose the account tier from measured lookup volume; no paid subscription is assumed. [AbuseIPDB check API and quotas](https://docs.abuseipdb.com/)

Label IP location as approximate. It cannot identify a household, street address, or the person using a VPN. Include accuracy radius when the chosen provider supplies it; show less specific information when city data is unavailable. [MaxMind geolocation limitations](https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy)

Each provider result needs source, fetched time, expiry, outcome (`available`, `not_configured`, `pending`, `stale`, `unavailable`, or `not_applicable`), and validated nullable fields. Maintain the last successful result if a refresh fails, but show it as stale when applicable. A refresh failure must not fabricate location or mark the address safe.

### Response actions

Provide temporary block/unblock with a mandatory reason, clear scope and expiry, and a warning about affected verified sessions when a shared office connection is involved. Add case creation/linking and analyst notes using the existing incident/audit structures. Offer session revocation only for a verified identity session selected by the investigator, never by assuming every user behind an IP is the same person.

An application block must deny actual relevant requests inside the selected organization. The UI distinguishes `recorded`, `pending`, `enforced`, `failed`, and `expired` action states, with enforcement location. Database policy plus audit commit together. For an external integration, use an outbox/job and store the remote acknowledgment before declaring enforcement.

Use application enforcement first. Tenant actions must not automatically become VPS-wide firewall rules or global blocks affecting other organizations. Protect a documented administrator recovery path and trusted infrastructure exceptions. If a connected client system cannot enforce a requested block, state that limitation explicitly.

The existing trusted-proxy resolver is a good starting point. Verify the deployed Caddy/any-CDN chain, maintain a narrow trust configuration, and test IPv6 proxy networks. Do not take a supplied forwarded header as authoritative merely because it exists. If Cloudflare is actually part of that chain, its documented client-IP headers can be used only through the configured trusted path. [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)

## Proposed backend changes

- Introduce a shared strict IP parser/classifier. Lookup accepts a single IP, not a hostname, URL, port, or CIDR. Keep submitted/observed text for evidence while comparing a canonical address.
- Add canonical PostgreSQL `inet` fields where appropriate, backfill validated historical values, and report invalid legacy values for review. Do not blindly cast or delete legacy event rows. Add an organization/address/time index for bounded investigation queries.
- Centralize the security events needed by this investigation. Add normalized event categories and stable IDs; record each outcome once. Associate anonymous events only with a trusted registered host/integration context. Unscoped traffic belongs to a restricted platform event stream, not every tenant's log.
- Maintain event counts/risk from durable events, through scoped queries or idempotent aggregate jobs. Keep `observed_at`, `fetched_at`, and `evaluated_at` distinct.
- Add backend provider adapters with fixed HTTPS destinations, validated payloads, timeouts, response-size limits, per-actor/organization rate limits, caching, refresh deduplication, and quota/error monitoring. Browser-submitted URLs or provider facts must not drive fetches or trusted intelligence.
- Keep optional provider keys on the backend and expose only configuration/health status. Provisional refresh TTLs: network facts 24 hours, reputation 1 hour, configurable within provider terms and quotas.
- Extend the existing investigation response additively; retain existing fields during frontend migration. Add `query_window`, `classification`, `assessment`, `enrichment_status`, `related_accounts`, `related_assets`, and `containment`.
- Extend `GET /api/security/events` with a validated `ip_address` filter and existing cursor pagination. Keep `POST /api/security/enrich-ip` as the explicit refresh action, with real success/failure/pending outcomes and no read-triggered uncontrolled provider spending.
- Apply `security.investigate` consistently to investigation/enrichment access, `security.contain` to response actions, and `security.audit` to action history. Preserve the existing admin/IT security-staff compatibility policy unless changed explicitly.
- Audit lookups, refreshes, notes, exports, blocks, unblocks, and verified-session revocations, with actor, time, reason where required, and action outcome. Redact passwords, cookies, tokens, and nested secret fields, including objects in arrays. Set retention and export limits before rollout.
- Preserve session persistence: no new inactivity logout, no forced reauthentication based only on location/IP change, and no automatic login restriction solely because an address is a VPN or shared connection.

## Delivery order

| Stage | Deliverables | Completion condition |
| --- | --- | --- |
| 1. Reliable evidence | IP validation/canonicalization; telemetry gaps; trustworthy counts/timestamps; risk reasons; filtered timeline API; corrected current-provider error handling | Real events produce the expected investigation. Invalid/private inputs behave correctly, and provider failures cannot look successful. |
| 2. Effective response | Organization-scoped block enforcement; expiry; verified-session revocation; atomic action/audit writes; incident links; recovery policy | A permitted action changes actual request/session behavior, with recorded evidence; expiry/unblock restores access and other tenants remain unaffected. |
| 3. Enriched investigation page | One reputation adapter; provider health/cache/freshness; UI evidence panels, timeline, filter controls, and acknowledged action states | Real provider results are distinguishable from missing data; the UI reflects actual server evidence/actions and works during provider outages. |

A reviewable release should include stages 1 and 2 plus their UI integration. External reputation is optional until a provider key and acceptable quota are configured. Later enhancements can include additional intelligence sources, broader integration enforcement, and tuned automated temporary containment. Defer them until the initial evidence and controls are reliable.

## Verification and rollout plan

Use an isolated migrated PostgreSQL database and actual HTTP requests. Required cases include:

- IPv4, equivalent IPv6 forms, mapped IPv4, invalid inputs, and non-public ranges.
- Trusted-proxy extraction and spoofed forwarded headers; IPv6 trust configuration.
- Organization isolation and read-only investigator versus containment permissions.
- Real login success/failure, anonymous traffic under verified scope, 403/429 events, and duplicate-emission prevention.
- Windowed summaries, cursor pagination, risk evidence, and maintained first/last-seen values.
- Provider timeout, quota exhaustion, malformed payloads, HTTP-200 error payloads, missing credentials, stale cache, and concurrent refresh deduplication.
- Actual blocked request, allowed request, expiry, unblock, concurrent policy updates, and audit failure rollback.
- Revocation of the selected `identity.sessions` record and denial of both its access and refresh credentials; unrelated sessions continue to work.
- Existing login persistence and ordinary product access remain correct for all roles.

Deterministic provider fault tests can use explicit test adapters. Before rollout, also perform a limited live lookup through the configured provider and label that as live verification; no stub or synthetic data should appear as production evidence.

Frontend verification covers one request per lookup, rapid consecutive searches without stale results, real timeline filters, permission-gated actions, pending/failed/expired enforcement states, and an unavailable provider without losing internal evidence.

Deploy database changes before code that depends on them. Backfill/index work must be reviewed against actual event volume. Release new containment behavior behind an initially disabled enforcement flag, validate a controlled block/expiry/unblock on the VPS, then enable the agreed organization scope. Observe lookup latency, provider errors/quota, event ingestion gaps, and action-enforcement failures. Disabling the feature must not disrupt ordinary authentication.

## Recommended scope for implementation approval

Approve the reliable investigation and organization-scoped application response described above, with one optional backend-only reputation adapter. Provider credentials/tier and any external client enforcement require configuration decisions before that part is enabled. The present review does not authorize implementation or deployment; it provides the concrete plan for that next step.
