/**
 * Live Supabase → Kode cutover for:
 * - shoot approvals (fleet vehicles + shoot bookings)
 * - monthly obligations + occurrences
 * - security center
 * - attendance sessions + daily status
 * - time entries (upsert delta)
 * - service desk tickets + comments (upsert)
 * - location planner (locations, roles, slots, assignments, off days)
 *
 * Usage:
 *   npx tsx scripts/migration/migrate-live-cutover.ts            # dry run
 *   npx tsx scripts/migration/migrate-live-cutover.ts --apply
 *   npx tsx scripts/migration/migrate-live-cutover.ts --apply --only=location-planner
 */
import type { PoolClient } from 'pg';
import { db } from '../../src/db/pool.js';
import {
  asBoolean,
  asJson,
  asNumber,
  asString,
  fetchAllRows,
  optionalId,
  type JsonRow,
} from './supabase-rest.js';

const apply = process.argv.includes('--apply');
const modulesArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = new Set(
  modulesArg
    ? modulesArg
        .slice('--only='.length)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : [],
);

function want(name: string) {
  return only.size === 0 || only.has(name);
}

function log(message: string) {
  console.log(`[live-cutover] ${message}`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

async function loadRefs(client: PoolClient) {
  const orgs = await client.query<{ id: string }>(
    'SELECT id FROM organizations.organizations',
  );
  const users = await client.query<{ id: string }>(
    'SELECT id FROM identity.users',
  );
  const cards = await client.query<{ id: string }>('SELECT id FROM work.cards');
  const offices = await client.query<{ id: string }>(
    'SELECT id FROM organizations.offices',
  );
  return {
    organizations: new Set(orgs.rows.map((row) => row.id)),
    users: new Set(users.rows.map((row) => row.id)),
    cards: new Set(cards.rows.map((row) => row.id)),
    offices: new Set(offices.rows.map((row) => row.id)),
  };
}

type Refs = Awaited<ReturnType<typeof loadRefs>>;

function requireOrg(row: JsonRow, refs: Refs) {
  const organizationId = asString(row.organization_id);
  return organizationId && refs.organizations.has(organizationId)
    ? organizationId
    : null;
}

async function migrateFleetAndShoots(client: PoolClient, refs: Refs) {
  const vehicles = await fetchAllRows('fleet_vehicles');
  const bookings = await fetchAllRows('shoot_bookings');
  log(`Fetched fleet_vehicles=${vehicles.length} shoot_bookings=${bookings.length}`);

  let vehiclesImported = 0;
  let vehiclesSkipped = 0;
  for (const row of vehicles) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    if (!id || !organizationId) {
      vehiclesSkipped += 1;
      continue;
    }
    if (!apply) {
      vehiclesImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO media.fleet_vehicles (
          id, organization_id, vehicle_name, registration_number, status,
          created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,''),'available'),
                COALESCE($6::timestamptz, NOW()), COALESCE($7::timestamptz, NOW()))
        ON CONFLICT (id) DO UPDATE SET
          vehicle_name = EXCLUDED.vehicle_name,
          registration_number = EXCLUDED.registration_number,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        asString(row.vehicle_name),
        asString(row.registration_number),
        asString(row.status) ?? 'available',
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    vehiclesImported += 1;
  }

  const knownVehicles = new Set(
    (
      await client.query<{ id: string }>('SELECT id FROM media.fleet_vehicles')
    ).rows.map((row) => row.id),
  );
  // Dry-run: pretend fetched vehicles exist
  if (!apply) {
    for (const row of vehicles) {
      const id = asString(row.id);
      if (id) knownVehicles.add(id);
    }
  }

  const statuses = new Set(['pending', 'approved', 'rejected', 'cancelled']);
  let bookingsImported = 0;
  let bookingsSkipped = 0;
  for (const row of bookings) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const requestedBy = optionalId(row.requested_by, refs.users);
    const title = asString(row.title)?.trim();
    const location = asString(row.location)?.trim();
    const startsAt = asString(row.starts_at);
    const endsAt = asString(row.ends_at);
    const vehicleId = optionalId(row.vehicle_id, knownVehicles);
    const vehicleOther = asString(row.vehicle_other)?.trim() || null;
    const statusRaw = asString(row.status) ?? 'pending';
    const status = statuses.has(statusRaw) ? statusRaw : 'pending';

    if (
      !id ||
      !organizationId ||
      !requestedBy ||
      !title ||
      !location ||
      !startsAt ||
      !endsAt ||
      (!vehicleId && !vehicleOther)
    ) {
      bookingsSkipped += 1;
      continue;
    }

    if (!apply) {
      bookingsImported += 1;
      continue;
    }

    await client.query(
      `
        INSERT INTO media.shoot_bookings (
          id, organization_id, office_id, vehicle_id, vehicle_other,
          title, client_name, location, notes, starts_at, ends_at, status,
          requested_by, reviewed_by, reviewed_at, review_note,
          created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,
          $13,$14,$15::timestamptz,$16,
          COALESCE($17::timestamptz, NOW()), COALESCE($18::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          office_id = EXCLUDED.office_id,
          vehicle_id = EXCLUDED.vehicle_id,
          vehicle_other = EXCLUDED.vehicle_other,
          title = EXCLUDED.title,
          client_name = EXCLUDED.client_name,
          location = EXCLUDED.location,
          notes = EXCLUDED.notes,
          starts_at = EXCLUDED.starts_at,
          ends_at = EXCLUDED.ends_at,
          status = EXCLUDED.status,
          reviewed_by = EXCLUDED.reviewed_by,
          reviewed_at = EXCLUDED.reviewed_at,
          review_note = EXCLUDED.review_note,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        optionalId(row.office_id, refs.offices),
        vehicleId,
        vehicleOther,
        title,
        asString(row.client_name),
        location,
        asString(row.notes),
        startsAt,
        endsAt,
        status,
        requestedBy,
        optionalId(row.reviewed_by, refs.users),
        asString(row.reviewed_at),
        asString(row.review_note),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    bookingsImported += 1;
  }

  return {
    vehiclesImported,
    vehiclesSkipped,
    bookingsImported,
    bookingsSkipped,
  };
}

async function migrateObligations(client: PoolClient, refs: Refs) {
  const obligations = await fetchAllRows('monthly_obligations');
  const occurrences = await fetchAllRows('monthly_obligation_occurrences');
  log(
    `Fetched monthly_obligations=${obligations.length} occurrences=${occurrences.length}`,
  );

  let obligationsImported = 0;
  let obligationsSkipped = 0;
  for (const row of obligations) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const assigneeId = optionalId(row.assignee_id, refs.users);
    const title = asString(row.title)?.trim();
    const dueDay = asNumber(row.due_day_of_month, 0);
    if (!id || !organizationId || !assigneeId || !title || dueDay < 1 || dueDay > 28) {
      obligationsSkipped += 1;
      continue;
    }
    if (!apply) {
      obligationsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO obligations.monthly_obligations (
          id, organization_id, title, description, due_day_of_month,
          assignee_id, created_by, is_active, archived_at, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9::timestamptz,
          COALESCE($10::timestamptz, NOW()), COALESCE($11::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          due_day_of_month = EXCLUDED.due_day_of_month,
          assignee_id = EXCLUDED.assignee_id,
          is_active = EXCLUDED.is_active,
          archived_at = EXCLUDED.archived_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        title,
        asString(row.description),
        dueDay,
        assigneeId,
        optionalId(row.created_by, refs.users),
        asBoolean(row.is_active, true),
        asString(row.archived_at),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    obligationsImported += 1;
  }

  const knownObligations = new Set(
    (
      await client.query<{ id: string }>(
        'SELECT id FROM obligations.monthly_obligations',
      )
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of obligations) {
      const id = asString(row.id);
      if (id) knownObligations.add(id);
    }
  }

  const statuses = new Set(['pending', 'due', 'overdue', 'submitted', 'skipped']);
  let occurrencesImported = 0;
  let occurrencesSkipped = 0;
  for (const row of occurrences) {
    const id = asString(row.id);
    const obligationId = optionalId(row.obligation_id, knownObligations);
    const organizationId = requireOrg(row, refs);
    const periodYear = asNumber(row.period_year, 0);
    const periodMonth = asNumber(row.period_month, 0);
    const dueOn = asString(row.due_on);
    const statusRaw = asString(row.status) ?? 'pending';
    const status = statuses.has(statusRaw) ? statusRaw : 'pending';
    if (
      !id ||
      !obligationId ||
      !organizationId ||
      !dueOn ||
      periodYear < 2000 ||
      periodMonth < 1 ||
      periodMonth > 12
    ) {
      occurrencesSkipped += 1;
      continue;
    }
    if (!apply) {
      occurrencesImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO obligations.occurrences (
          id, obligation_id, organization_id, period_year, period_month,
          due_on, status, submitted_at, submitted_by, submission_note,
          created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6::date,$7,$8::timestamptz,$9,$10,
          COALESCE($11::timestamptz, NOW()), COALESCE($12::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          due_on = EXCLUDED.due_on,
          submitted_at = EXCLUDED.submitted_at,
          submitted_by = EXCLUDED.submitted_by,
          submission_note = EXCLUDED.submission_note,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        obligationId,
        organizationId,
        periodYear,
        periodMonth,
        dueOn,
        status,
        asString(row.submitted_at),
        optionalId(row.submitted_by, refs.users),
        asString(row.submission_note),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    occurrencesImported += 1;
  }

  return {
    obligationsImported,
    obligationsSkipped,
    occurrencesImported,
    occurrencesSkipped,
  };
}

async function migrateSecurity(client: PoolClient, refs: Refs) {
  const sessions = await fetchAllRows('security_sessions');
  const devices = await fetchAllRows('security_devices');
  const ips = await fetchAllRows('security_ip_reputation');
  const blocklist = await fetchAllRows('security_blocklist');
  const events = await fetchAllRows('security_events');
  const alerts = await fetchAllRows('security_alerts');
  const incidents = await fetchAllRows('security_incidents');
  const verifications = await fetchAllRows('security_login_verifications');

  log(
    `Fetched security sessions=${sessions.length} devices=${devices.length} ips=${ips.length} blocklist=${blocklist.length} events=${events.length} alerts=${alerts.length} incidents=${incidents.length} verifications=${verifications.length}`,
  );

  let sessionsImported = 0;
  let sessionsSkipped = 0;
  for (const row of sessions) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const userId = optionalId(row.user_id, refs.users);
    if (!id || !organizationId || !userId) {
      sessionsSkipped += 1;
      continue;
    }
    if (!apply) {
      sessionsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO security.sessions (
          id, organization_id, user_id, auth_session_id, ip_address, country, city,
          user_agent, browser, os, device, risk_score, reauthentication_required,
          started_at, last_seen_at, ended_at,
          precise_latitude, precise_longitude, location_accuracy_meters,
          location_permission_granted, location_captured_at, location_source,
          device_fingerprint, metadata
        )
        VALUES (
          $1,$2,$3,$4::uuid,$5,$6,$7,
          $8,$9,$10,$11,$12,$13,
          COALESCE($14::timestamptz, NOW()), COALESCE($15::timestamptz, NOW()), $16::timestamptz,
          $17,$18,$19,
          $20,$21::timestamptz,COALESCE(NULLIF($22,''),'ip'),
          $23,$24::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          ip_address = EXCLUDED.ip_address,
          country = EXCLUDED.country,
          city = EXCLUDED.city,
          risk_score = EXCLUDED.risk_score,
          last_seen_at = EXCLUDED.last_seen_at,
          ended_at = EXCLUDED.ended_at,
          metadata = EXCLUDED.metadata
      `,
      [
        id,
        organizationId,
        userId,
        asString(row.auth_session_id),
        asString(row.ip_address),
        asString(row.country),
        asString(row.city),
        asString(row.user_agent),
        asString(row.browser),
        asString(row.os),
        asString(row.device),
        Math.max(0, asNumber(row.risk_score)),
        asBoolean(row.reauthentication_required),
        asString(row.started_at),
        asString(row.last_seen_at),
        asString(row.ended_at),
        row.precise_latitude ?? null,
        row.precise_longitude ?? null,
        row.location_accuracy_meters ?? null,
        row.location_permission_granted ?? null,
        asString(row.location_captured_at),
        asString(row.location_source) ?? 'ip',
        asString(row.device_fingerprint),
        JSON.stringify(asJson(row.metadata, {})),
      ],
    );
    sessionsImported += 1;
  }

  const knownSessions = new Set(
    (
      await client.query<{ id: string }>('SELECT id FROM security.sessions')
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of sessions) {
      const id = asString(row.id);
      if (id) knownSessions.add(id);
    }
  }

  let devicesImported = 0;
  let devicesSkipped = 0;
  for (const row of devices) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const userId = optionalId(row.user_id, refs.users);
    const fingerprint = asString(row.fingerprint_hash)?.trim();
    if (!id || !organizationId || !userId || !fingerprint) {
      devicesSkipped += 1;
      continue;
    }
    if (!apply) {
      devicesImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO security.devices (
          id, organization_id, user_id, fingerprint_hash, user_agent, browser, os, device,
          first_ip_address, last_ip_address, country, city, trusted,
          first_seen_at, last_seen_at, metadata
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,$13,
          COALESCE($14::timestamptz, NOW()), COALESCE($15::timestamptz, NOW()), $16::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          last_ip_address = EXCLUDED.last_ip_address,
          country = EXCLUDED.country,
          city = EXCLUDED.city,
          trusted = EXCLUDED.trusted,
          last_seen_at = EXCLUDED.last_seen_at,
          metadata = EXCLUDED.metadata
      `,
      [
        id,
        organizationId,
        userId,
        fingerprint,
        asString(row.user_agent),
        asString(row.browser),
        asString(row.os),
        asString(row.device),
        asString(row.first_ip_address),
        asString(row.last_ip_address),
        asString(row.country),
        asString(row.city),
        asBoolean(row.trusted),
        asString(row.first_seen_at),
        asString(row.last_seen_at),
        JSON.stringify(asJson(row.metadata, {})),
      ],
    );
    devicesImported += 1;
  }

  let ipsImported = 0;
  let ipsSkipped = 0;
  for (const row of ips) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const ip = asString(row.ip_address)?.trim();
    if (!id || !organizationId || !ip) {
      ipsSkipped += 1;
      continue;
    }
    if (!apply) {
      ipsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO security.ip_reputation (
          id, organization_id, ip_address, country, city, region, latitude, longitude,
          timezone, isp, asn, enriched_at, risk_score, total_events, failed_logins,
          last_event_type, first_seen_at, last_seen_at, metadata
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12::timestamptz,$13,$14,$15,
          $16,COALESCE($17::timestamptz, NOW()), COALESCE($18::timestamptz, NOW()), $19::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          country = EXCLUDED.country,
          city = EXCLUDED.city,
          risk_score = EXCLUDED.risk_score,
          total_events = EXCLUDED.total_events,
          failed_logins = EXCLUDED.failed_logins,
          last_event_type = EXCLUDED.last_event_type,
          last_seen_at = EXCLUDED.last_seen_at,
          metadata = EXCLUDED.metadata
      `,
      [
        id,
        organizationId,
        ip,
        asString(row.country),
        asString(row.city),
        asString(row.region),
        row.latitude ?? null,
        row.longitude ?? null,
        asString(row.timezone),
        asString(row.isp),
        asString(row.asn),
        asString(row.enriched_at),
        Math.max(0, asNumber(row.risk_score)),
        Math.max(0, asNumber(row.total_events)),
        Math.max(0, asNumber(row.failed_logins)),
        asString(row.last_event_type),
        asString(row.first_seen_at),
        asString(row.last_seen_at),
        JSON.stringify(asJson(row.metadata, {})),
      ],
    );
    ipsImported += 1;
  }

  let blocklistImported = 0;
  let blocklistSkipped = 0;
  for (const row of blocklist) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const targetType = asString(row.target_type) ?? 'ip';
    const targetValue = asString(row.target_value)?.trim();
    const reason = asString(row.reason)?.trim();
    if (
      !id ||
      !organizationId ||
      !targetValue ||
      !reason ||
      !['ip', 'email'].includes(targetType)
    ) {
      blocklistSkipped += 1;
      continue;
    }
    if (!apply) {
      blocklistImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO security.blocklist (
          id, organization_id, target_type, target_value, reason,
          blocked_by, blocked_at, expires_at, unblocked_at, unblocked_by, metadata
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10,$11::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          reason = EXCLUDED.reason,
          expires_at = EXCLUDED.expires_at,
          unblocked_at = EXCLUDED.unblocked_at,
          unblocked_by = EXCLUDED.unblocked_by,
          metadata = EXCLUDED.metadata
      `,
      [
        id,
        organizationId,
        targetType,
        targetValue,
        reason,
        optionalId(row.blocked_by, refs.users),
        asString(row.blocked_at) ?? new Date().toISOString(),
        asString(row.expires_at),
        asString(row.unblocked_at),
        optionalId(row.unblocked_by, refs.users),
        JSON.stringify(asJson(row.metadata, {})),
      ],
    );
    blocklistImported += 1;
  }

  const eventSeverities = new Set(['info', 'low', 'medium', 'high', 'critical']);
  let eventsImported = 0;
  let eventsSkipped = 0;
  for (const row of events) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const eventType = asString(row.event_type)?.trim();
    const severityRaw = asString(row.severity) ?? 'low';
    const severity = eventSeverities.has(severityRaw) ? severityRaw : 'low';
    if (!id || !organizationId || !eventType) {
      eventsSkipped += 1;
      continue;
    }
    if (!apply) {
      eventsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO security.events (
          id, organization_id, user_id, session_id, ip_address, country, city, region,
          latitude, longitude, timezone, isp, asn, enriched_at,
          user_agent, browser, os, device, request_method, endpoint,
          event_type, severity, risk_score, successful,
          precise_latitude, precise_longitude, location_accuracy_meters,
          location_permission_granted, location_captured_at, location_source,
          device_fingerprint, platform, screen_width, screen_height, language,
          hardware_concurrency, device_memory, metadata, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,$13,$14::timestamptz,
          $15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,
          $25,$26,$27,
          $28,$29::timestamptz,COALESCE(NULLIF($30,''),'ip'),
          $31,$32,$33,$34,$35,
          $36,$37,$38::jsonb,COALESCE($39::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          severity = EXCLUDED.severity,
          risk_score = EXCLUDED.risk_score,
          metadata = EXCLUDED.metadata
      `,
      [
        id,
        organizationId,
        optionalId(row.user_id, refs.users),
        optionalId(row.session_id, knownSessions),
        asString(row.ip_address),
        asString(row.country),
        asString(row.city),
        asString(row.region),
        row.latitude ?? null,
        row.longitude ?? null,
        asString(row.timezone),
        asString(row.isp),
        asString(row.asn),
        asString(row.enriched_at),
        asString(row.user_agent),
        asString(row.browser),
        asString(row.os),
        asString(row.device),
        asString(row.request_method),
        asString(row.endpoint),
        eventType,
        severity,
        Math.max(0, asNumber(row.risk_score)),
        asBoolean(row.successful),
        row.precise_latitude ?? null,
        row.precise_longitude ?? null,
        row.location_accuracy_meters ?? null,
        row.location_permission_granted ?? null,
        asString(row.location_captured_at),
        asString(row.location_source) ?? 'ip',
        asString(row.device_fingerprint),
        asString(row.platform),
        row.screen_width ?? null,
        row.screen_height ?? null,
        asString(row.language),
        row.hardware_concurrency ?? null,
        row.device_memory ?? null,
        JSON.stringify(asJson(row.metadata, {})),
        asString(row.created_at),
      ],
    );
    eventsImported += 1;
  }

  const knownEvents = new Set(
    (
      await client.query<{ id: string }>('SELECT id FROM security.events')
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of events) {
      const id = asString(row.id);
      if (id) knownEvents.add(id);
    }
  }

  const alertSeverities = new Set(['low', 'medium', 'high', 'critical']);
  const alertStatuses = new Set(['open', 'acknowledged', 'resolved', 'dismissed']);
  let alertsImported = 0;
  let alertsSkipped = 0;
  for (const row of alerts) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const title = asString(row.title)?.trim();
    const severityRaw = asString(row.severity) ?? 'medium';
    const severity = alertSeverities.has(severityRaw)
      ? severityRaw
      : severityRaw === 'info'
        ? 'low'
        : 'medium';
    const statusRaw = asString(row.status) ?? 'open';
    const status = alertStatuses.has(statusRaw) ? statusRaw : 'open';
    if (!id || !organizationId || !title) {
      alertsSkipped += 1;
      continue;
    }
    if (!apply) {
      alertsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO security.alerts (
          id, organization_id, event_id, user_id, ip_address, title, description,
          severity, status, resolved_by, resolved_at, resolution_notes, metadata, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          $8,$9,$10,$11::timestamptz,$12,$13::jsonb,COALESCE($14::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          severity = EXCLUDED.severity,
          status = EXCLUDED.status,
          resolved_by = EXCLUDED.resolved_by,
          resolved_at = EXCLUDED.resolved_at,
          resolution_notes = EXCLUDED.resolution_notes,
          metadata = EXCLUDED.metadata
      `,
      [
        id,
        organizationId,
        optionalId(row.event_id, knownEvents),
        optionalId(row.user_id, refs.users),
        asString(row.ip_address),
        title,
        asString(row.description),
        severity,
        status,
        optionalId(row.resolved_by, refs.users),
        asString(row.resolved_at),
        asString(row.resolution_notes),
        JSON.stringify(asJson(row.metadata, {})),
        asString(row.created_at),
      ],
    );
    alertsImported += 1;
  }

  let incidentsImported = 0;
  let incidentsSkipped = 0;
  for (const row of incidents) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const title = asString(row.title)?.trim();
    if (!id || !organizationId || !title) {
      incidentsSkipped += 1;
      continue;
    }
    if (!apply) {
      incidentsImported += 1;
      continue;
    }
    const eventIds = Array.isArray(row.event_ids)
      ? (row.event_ids as unknown[]).filter(
          (value): value is string =>
            typeof value === 'string' && knownEvents.has(value),
        )
      : [];
    await client.query(
      `
        INSERT INTO security.incidents (
          id, organization_id, title, description, severity, status,
          related_user_id, related_ip_address, event_ids, admin_notes,
          assigned_to, created_by, resolved_by, resolved_at, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,COALESCE(NULLIF($5,''),'medium'),COALESCE(NULLIF($6,''),'open'),
          $7,$8,$9::uuid[],$10,
          $11,$12,$13,$14::timestamptz,
          COALESCE($15::timestamptz, NOW()), COALESCE($16::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          severity = EXCLUDED.severity,
          status = EXCLUDED.status,
          event_ids = EXCLUDED.event_ids,
          admin_notes = EXCLUDED.admin_notes,
          resolved_at = EXCLUDED.resolved_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        title,
        asString(row.description),
        asString(row.severity) ?? 'medium',
        asString(row.status) ?? 'open',
        optionalId(row.related_user_id, refs.users),
        asString(row.related_ip_address),
        eventIds,
        asString(row.admin_notes),
        optionalId(row.assigned_to, refs.users),
        optionalId(row.created_by, refs.users),
        optionalId(row.resolved_by, refs.users),
        asString(row.resolved_at),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    incidentsImported += 1;
  }

  const verificationStatuses = new Set([
    'pending_location',
    'pending_email_otp',
    'manual_review',
    'approved',
    'rejected',
    'expired',
  ]);
  let verificationsImported = 0;
  let verificationsSkipped = 0;
  for (const row of verifications) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const userId = optionalId(row.user_id, refs.users);
    const statusRaw = asString(row.status) ?? 'pending_location';
    const status = verificationStatuses.has(statusRaw)
      ? statusRaw
      : 'pending_location';
    if (!id || !organizationId || !userId) {
      verificationsSkipped += 1;
      continue;
    }
    if (!apply) {
      verificationsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO security.login_verifications (
          id, organization_id, user_id, status, risk_score, risk_signals,
          ip_address, approximate_country, approximate_city,
          approximate_latitude, approximate_longitude, browser, os, device,
          location_permission_granted, location_accuracy_meters, location_source,
          reviewed_at, review_notes, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6::jsonb,
          $7,$8,$9,
          $10,$11,$12,$13,$14,
          $15,$16,COALESCE(NULLIF($17,''),'ip'),
          $18::timestamptz,$19,COALESCE($20::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          risk_score = EXCLUDED.risk_score,
          reviewed_at = EXCLUDED.reviewed_at,
          review_notes = EXCLUDED.review_notes
      `,
      [
        id,
        organizationId,
        userId,
        status,
        Math.max(0, asNumber(row.risk_score)),
        JSON.stringify(asJson(row.risk_signals, [])),
        asString(row.ip_address),
        asString(row.approximate_country),
        asString(row.approximate_city),
        row.approximate_latitude ?? null,
        row.approximate_longitude ?? null,
        asString(row.browser),
        asString(row.os),
        asString(row.device),
        asBoolean(row.location_permission_granted),
        row.location_accuracy_meters ?? null,
        asString(row.location_source) ?? 'ip',
        asString(row.reviewed_at),
        asString(row.review_notes),
        asString(row.created_at),
      ],
    );
    verificationsImported += 1;
  }

  return {
    sessionsImported,
    sessionsSkipped,
    devicesImported,
    devicesSkipped,
    ipsImported,
    ipsSkipped,
    blocklistImported,
    blocklistSkipped,
    eventsImported,
    eventsSkipped,
    alertsImported,
    alertsSkipped,
    incidentsImported,
    incidentsSkipped,
    verificationsImported,
    verificationsSkipped,
  };
}

async function migrateAttendance(client: PoolClient, refs: Refs) {
  const sessions = await fetchAllRows('attendance_sessions');
  const daily = await fetchAllRows('attendance_daily_status');
  log(
    `Fetched attendance_sessions=${sessions.length} daily_status=${daily.length}`,
  );

  const statuses = new Set(['active', 'completed', 'missed_clock_out']);
  // Only one active open session per user is allowed in Kode.
  const latestActiveByUser = new Map<string, string>();
  for (const row of sessions) {
    const userId = asString(row.user_id);
    const id = asString(row.id);
    const clockInAt = asString(row.clock_in_at);
    const clockOutAt = asString(row.clock_out_at);
    const statusRaw = asString(row.status) ?? 'completed';
    if (!userId || !id || !clockInAt || clockOutAt) continue;
    if (statusRaw !== 'active' && statusRaw !== 'completed') continue;
    if (statusRaw === 'active' || !clockOutAt) {
      const previous = latestActiveByUser.get(userId);
      if (!previous) {
        latestActiveByUser.set(userId, id);
        continue;
      }
      const previousRow = sessions.find((candidate) => asString(candidate.id) === previous);
      const previousClock = asString(previousRow?.clock_in_at) ?? '';
      if (clockInAt > previousClock) latestActiveByUser.set(userId, id);
    }
  }

  let sessionsImported = 0;
  let sessionsSkipped = 0;
  for (const row of sessions) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const userId = optionalId(row.user_id, refs.users);
    const clockInAt = asString(row.clock_in_at);
    const clockOutAt = asString(row.clock_out_at);
    let statusRaw = asString(row.status) ?? 'completed';
    if (!clockOutAt && userId && id && latestActiveByUser.get(userId) !== id) {
      statusRaw = 'missed_clock_out';
    } else if (!clockOutAt && statusRaw !== 'active') {
      statusRaw = latestActiveByUser.get(userId ?? '') === id ? 'active' : 'missed_clock_out';
    } else if (clockOutAt) {
      statusRaw = statusRaw === 'active' ? 'completed' : statusRaw;
    }
    const status = statuses.has(statusRaw)
      ? statusRaw
      : clockOutAt
        ? 'completed'
        : 'missed_clock_out';
    if (!id || !organizationId || !userId || !clockInAt) {
      sessionsSkipped += 1;
      continue;
    }
    if (!apply) {
      sessionsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO attendance.sessions (
          id, organization_id, office_id, user_id, clock_in_at, clock_out_at,
          status, work_seconds, clock_in_method, clock_out_method, notes,
          ip_address, device_info, location, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,
          $7,$8,COALESCE(NULLIF($9,''),'web'),$10,$11,
          $12,$13::jsonb,$14::jsonb,
          COALESCE($15::timestamptz, NOW()), COALESCE($16::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          clock_out_at = EXCLUDED.clock_out_at,
          status = EXCLUDED.status,
          work_seconds = EXCLUDED.work_seconds,
          clock_out_method = EXCLUDED.clock_out_method,
          notes = EXCLUDED.notes,
          device_info = EXCLUDED.device_info,
          location = EXCLUDED.location,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        optionalId(row.office_id, refs.offices),
        userId,
        clockInAt,
        clockOutAt,
        status,
        Math.max(0, asNumber(row.work_seconds, asNumber(row.total_minutes) * 60)),
        asString(row.clock_in_method) ?? 'web',
        asString(row.clock_out_method),
        asString(row.notes),
        asString(row.ip_address),
        JSON.stringify(asJson(row.device_info, {})),
        JSON.stringify(asJson(row.location, {})),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    sessionsImported += 1;
  }

  const knownSessions = new Set(
    (
      await client.query<{ id: string }>('SELECT id FROM attendance.sessions')
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of sessions) {
      const id = asString(row.id);
      if (id) knownSessions.add(id);
    }
  }

  const dailyStatuses = new Set([
    'present',
    'late',
    'absent',
    'on_leave',
    'pending',
  ]);
  let dailyImported = 0;
  let dailySkipped = 0;
  for (const row of daily) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const userId = optionalId(row.user_id, refs.users);
    const attendanceDate = asString(row.attendance_date);
    const statusRaw = asString(row.status) ?? 'present';
    const status = dailyStatuses.has(statusRaw) ? statusRaw : 'present';
    if (!id || !organizationId || !userId || !attendanceDate) {
      dailySkipped += 1;
      continue;
    }
    if (!apply) {
      dailyImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO attendance.daily_status (
          id, organization_id, office_id, user_id, attendance_date, status,
          expected_clock_in_at, actual_clock_in_at, session_id, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5::date,$6,
          $7::timestamptz,$8::timestamptz,$9,
          COALESCE($10::timestamptz, NOW()), COALESCE($11::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          expected_clock_in_at = EXCLUDED.expected_clock_in_at,
          actual_clock_in_at = EXCLUDED.actual_clock_in_at,
          session_id = EXCLUDED.session_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        optionalId(row.office_id, refs.offices),
        userId,
        attendanceDate,
        status,
        asString(row.expected_clock_in_at),
        asString(row.actual_clock_in_at),
        optionalId(row.session_id, knownSessions),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    dailyImported += 1;
  }

  return {
    sessionsImported,
    sessionsSkipped,
    dailyImported,
    dailySkipped,
  };
}

async function migrateTimeEntries(client: PoolClient, refs: Refs) {
  const entries = await fetchAllRows('time_entries');
  log(`Fetched time_entries=${entries.length}`);

  let imported = 0;
  let skipped = 0;
  for (const row of entries) {
    const id = asString(row.id);
    const cardId = optionalId(row.task_id, refs.cards);
    const userId = optionalId(row.user_id, refs.users);
    const organizationId = requireOrg(row, refs);
    if (!id || !cardId || !userId || !organizationId || asString(row.deleted_at)) {
      skipped += 1;
      continue;
    }
    if (!apply) {
      imported += 1;
      continue;
    }
    const isRunning = asBoolean(row.is_running);
    await client.query(
      `
        INSERT INTO work.time_entries (
          id, card_id, organization_id, user_id, created_by, seconds, note,
          started_at, ended_at, is_billable, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$4,$5,$6,
          $7::timestamptz,$8::timestamptz,$9,
          COALESCE($10::timestamptz, NOW()), COALESCE($11::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          seconds = EXCLUDED.seconds,
          note = EXCLUDED.note,
          started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at,
          is_billable = EXCLUDED.is_billable,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        cardId,
        organizationId,
        userId,
        Math.max(0, asNumber(row.duration_seconds)),
        asString(row.description)?.trim() || null,
        asString(row.started_at),
        isRunning ? null : asString(row.ended_at),
        asBoolean(row.is_billable),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    imported += 1;
  }

  if (apply) {
    await client.query(`
      UPDATE work.cards card
      SET tracked_seconds_cache = COALESCE((
        SELECT SUM(entry.seconds)
        FROM work.time_entries entry
        WHERE entry.organization_id = card.organization_id
          AND entry.card_id = card.id
          AND entry.deleted_at IS NULL
      ), 0)
    `);
  }

  return { imported, skipped };
}

async function migrateTickets(client: PoolClient, refs: Refs) {
  const tickets = await fetchAllRows('tickets');
  const comments = await fetchAllRows('ticket_comments');
  log(`Fetched tickets=${tickets.length} comments=${comments.length}`);

  const statuses = new Set([
    'open',
    'assigned',
    'in_progress',
    'waiting_for_requester',
    'waiting_for_third_party',
    'resolved',
    'closed',
    'reopened',
  ]);
  const priorities = new Set(['low', 'medium', 'high', 'urgent']);
  const requesterTypes = new Set(['internal', 'external']);

  let ticketsImported = 0;
  let ticketsSkipped = 0;
  for (const row of tickets) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const ticketNumber = asString(row.ticket_number)?.trim();
    const subject = asString(row.subject)?.trim();
    const description = asString(row.description) ?? '';
    const statusRaw = asString(row.status) ?? 'open';
    const priorityRaw = asString(row.priority) ?? 'medium';
    const requesterTypeRaw = asString(row.requester_type) ?? 'internal';
    const category = asString(row.category)?.trim() || 'general';
    if (!id || !organizationId || !subject || !ticketNumber) {
      ticketsSkipped += 1;
      continue;
    }
    if (!apply) {
      ticketsImported += 1;
      continue;
    }
    const trackingToken = asString(row.tracking_token);
    await client.query(
      `
        INSERT INTO tickets.tickets (
          id, organization_id, office_id, linked_card_id, ticket_number, tracking_token,
          requester_type, user_id, created_by, assigned_to, requester_email,
          external_name, external_company, external_phone,
          category, subject, description, status, priority,
          resolved_at, closed_at, closed_by, closed_by_email, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,COALESCE($6::uuid, gen_random_uuid()),
          $7,$8,$9,$10,$11,
          $12,$13,$14,
          $15,$16,$17,$18,$19,
          $20::timestamptz,$21::timestamptz,$22,$23,
          COALESCE($24::timestamptz, NOW()), COALESCE($25::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          office_id = EXCLUDED.office_id,
          linked_card_id = EXCLUDED.linked_card_id,
          assigned_to = EXCLUDED.assigned_to,
          category = EXCLUDED.category,
          subject = EXCLUDED.subject,
          description = EXCLUDED.description,
          status = EXCLUDED.status,
          priority = EXCLUDED.priority,
          resolved_at = EXCLUDED.resolved_at,
          closed_at = EXCLUDED.closed_at,
          closed_by = EXCLUDED.closed_by,
          closed_by_email = EXCLUDED.closed_by_email,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        optionalId(row.office_id, refs.offices),
        optionalId(row.linked_task_id, refs.cards),
        ticketNumber,
        trackingToken,
        requesterTypes.has(requesterTypeRaw) ? requesterTypeRaw : 'internal',
        optionalId(row.user_id, refs.users),
        optionalId(row.created_by, refs.users),
        optionalId(row.assigned_to, refs.users),
        asString(row.requester_email) ?? asString(row.external_email),
        asString(row.external_name),
        asString(row.external_company),
        asString(row.external_phone),
        category,
        subject,
        description,
        statuses.has(statusRaw) ? statusRaw : 'open',
        priorities.has(priorityRaw) ? priorityRaw : 'medium',
        asString(row.resolved_at),
        asString(row.closed_at),
        optionalId(row.closed_by, refs.users),
        asString(row.closed_by_email),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    ticketsImported += 1;
  }

  const knownTickets = new Set(
    (
      await client.query<{ id: string }>('SELECT id FROM tickets.tickets')
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of tickets) {
      const id = asString(row.id);
      if (id) knownTickets.add(id);
    }
  }

  const visibilities = new Set(['public', 'internal']);
  const authorTypes = new Set(['internal', 'external']);
  let commentsImported = 0;
  let commentsSkipped = 0;
  for (const row of comments) {
    const id = asString(row.id);
    const ticketId = optionalId(row.ticket_id, knownTickets);
    const organizationId = requireOrg(row, refs);
    const body = asString(row.body)?.trim();
    if (!id || !ticketId || !organizationId || !body) {
      commentsSkipped += 1;
      continue;
    }
    if (!apply) {
      commentsImported += 1;
      continue;
    }
    const visibilityRaw = asString(row.visibility) ?? 'public';
    const authorTypeRaw = asString(row.author_type) ?? 'internal';
    await client.query(
      `
        INSERT INTO tickets.ticket_comments (
          id, ticket_id, organization_id, author_id, author_type, body, visibility,
          external_name, external_email, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,
          $8,$9,
          COALESCE($10::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          body = EXCLUDED.body,
          visibility = EXCLUDED.visibility
      `,
      [
        id,
        ticketId,
        organizationId,
        optionalId(row.author_id, refs.users),
        authorTypes.has(authorTypeRaw) ? authorTypeRaw : 'internal',
        body,
        visibilities.has(visibilityRaw) ? visibilityRaw : 'public',
        asString(row.external_author_name) ?? asString(row.external_name),
        asString(row.external_author_email) ?? asString(row.external_email),
        asString(row.created_at),
      ],
    );
    commentsImported += 1;
  }

  return {
    ticketsImported,
    ticketsSkipped,
    commentsImported,
    commentsSkipped,
  };
}

async function migrateLocationPlanner(client: PoolClient, refs: Refs) {
  const locations = await fetchAllRows('company_locations');
  const roles = await fetchAllRows('company_roles');
  const statusEvents = await fetchAllRows('location_status_events');
  const slots = await fetchAllRows('assignment_slots');
  const assignments = await fetchAllRows('employee_assignments');
  const skills = await fetchAllRows('employee_skills');
  const offDays = await fetchAllRows('tlb_employee_off_days');
  const weeklyOffDays = await fetchAllRows('tlb_employee_weekly_off_days');

  log(
    `Fetched locations=${locations.length} roles=${roles.length} status_events=${statusEvents.length} slots=${slots.length} assignments=${assignments.length} skills=${skills.length} off_days=${offDays.length} weekly_off_days=${weeklyOffDays.length}`,
  );

  const locationTypes = new Set([
    'activity_site',
    'office',
    'department',
    'team',
    'other',
  ]);
  const locationStatuses = new Set(['open', 'closed', 'limited']);

  let locationsImported = 0;
  let locationsSkipped = 0;
  for (const row of locations) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const name = asString(row.name)?.trim();
    const typeRaw = asString(row.type) ?? 'department';
    const statusRaw = asString(row.status) ?? 'open';
    if (!id || !organizationId || !name) {
      locationsSkipped += 1;
      continue;
    }
    if (!apply) {
      locationsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO location_planner.locations (
          id, organization_id, name, type, status, capacity, notes, is_active,
          created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          COALESCE($9::timestamptz, NOW()), COALESCE($10::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          status = EXCLUDED.status,
          capacity = EXCLUDED.capacity,
          notes = EXCLUDED.notes,
          is_active = EXCLUDED.is_active,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        name,
        locationTypes.has(typeRaw) ? typeRaw : 'other',
        locationStatuses.has(statusRaw) ? statusRaw : 'open',
        row.capacity ?? null,
        asString(row.notes),
        asBoolean(row.is_active, true),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    locationsImported += 1;
  }

  const knownLocations = new Set(
    (
      await client.query<{ id: string }>(
        'SELECT id FROM location_planner.locations',
      )
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of locations) {
      const id = asString(row.id);
      if (id) knownLocations.add(id);
    }
  }

  let rolesImported = 0;
  let rolesSkipped = 0;
  for (const row of roles) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const name = asString(row.name)?.trim();
    if (!id || !organizationId || !name) {
      rolesSkipped += 1;
      continue;
    }
    if (!apply) {
      rolesImported += 1;
      continue;
    }
    const requiredSkills = Array.isArray(row.required_skills)
      ? (row.required_skills as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    await client.query(
      `
        INSERT INTO location_planner.roles (
          id, organization_id, name, category, description, location_id,
          required_skills, is_temporary, is_active, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7::text[],$8,$9,
          COALESCE($10::timestamptz, NOW()), COALESCE($11::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          category = EXCLUDED.category,
          description = EXCLUDED.description,
          location_id = EXCLUDED.location_id,
          required_skills = EXCLUDED.required_skills,
          is_temporary = EXCLUDED.is_temporary,
          is_active = EXCLUDED.is_active,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        name,
        asString(row.category) || null,
        asString(row.description),
        optionalId(row.location_id, knownLocations),
        requiredSkills,
        asBoolean(row.is_temporary),
        asBoolean(row.is_active, true),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    rolesImported += 1;
  }

  const knownRoles = new Set(
    (
      await client.query<{ id: string }>('SELECT id FROM location_planner.roles')
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of roles) {
      const id = asString(row.id);
      if (id) knownRoles.add(id);
    }
  }

  let statusEventsImported = 0;
  let statusEventsSkipped = 0;
  for (const row of statusEvents) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const locationId = optionalId(row.location_id, knownLocations);
    const title = asString(row.title)?.trim();
    const statusRaw = asString(row.status) ?? 'open';
    const startDate = asString(row.start_date);
    const endDate = asString(row.end_date);
    if (
      !id ||
      !organizationId ||
      !locationId ||
      !title ||
      !startDate ||
      !endDate ||
      !locationStatuses.has(statusRaw)
    ) {
      statusEventsSkipped += 1;
      continue;
    }
    if (!apply) {
      statusEventsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO location_planner.status_events (
          id, organization_id, location_id, title, reason, status,
          start_date, end_date, notes, created_by, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7::date,$8::date,$9,$10,
          COALESCE($11::timestamptz, NOW()), COALESCE($12::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          reason = EXCLUDED.reason,
          status = EXCLUDED.status,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          notes = EXCLUDED.notes,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        locationId,
        title,
        asString(row.reason),
        statusRaw,
        startDate,
        endDate,
        asString(row.notes),
        optionalId(row.created_by, refs.users),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    statusEventsImported += 1;
  }

  const slotStatuses = new Set(['open', 'filled', 'closed']);
  const priorities = new Set(['low', 'normal', 'high']);
  let slotsImported = 0;
  let slotsSkipped = 0;
  for (const row of slots) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const locationId = optionalId(row.location_id, knownLocations);
    const title = asString(row.title)?.trim();
    const startDate = asString(row.start_date);
    const endDate = asString(row.end_date);
    const statusRaw = asString(row.status) ?? 'open';
    const priorityRaw = asString(row.priority) ?? 'normal';
    if (!id || !organizationId || !locationId || !title || !startDate || !endDate) {
      slotsSkipped += 1;
      continue;
    }
    if (!apply) {
      slotsImported += 1;
      continue;
    }
    const requiredSkills = Array.isArray(row.required_skills)
      ? (row.required_skills as unknown[]).filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    await client.query(
      `
        INSERT INTO location_planner.assignment_slots (
          id, organization_id, location_id, title, temporary_role_id, required_count,
          start_date, end_date, start_time, end_time, required_skills, priority,
          notes, status, created_by, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7::date,$8::date,$9::time,$10::time,$11::text[],$12,
          $13,$14,$15,
          COALESCE($16::timestamptz, NOW()), COALESCE($17::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          temporary_role_id = EXCLUDED.temporary_role_id,
          required_count = EXCLUDED.required_count,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          required_skills = EXCLUDED.required_skills,
          priority = EXCLUDED.priority,
          notes = EXCLUDED.notes,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        locationId,
        title,
        optionalId(row.temporary_role_id, knownRoles),
        Math.max(1, asNumber(row.required_count, 1)),
        startDate,
        endDate,
        asString(row.start_time),
        asString(row.end_time),
        requiredSkills,
        priorities.has(priorityRaw) ? priorityRaw : 'normal',
        asString(row.notes),
        slotStatuses.has(statusRaw) ? statusRaw : 'open',
        optionalId(row.created_by, refs.users),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    slotsImported += 1;
  }

  const knownSlots = new Set(
    (
      await client.query<{ id: string }>(
        'SELECT id FROM location_planner.assignment_slots',
      )
    ).rows.map((row) => row.id),
  );
  if (!apply) {
    for (const row of slots) {
      const id = asString(row.id);
      if (id) knownSlots.add(id);
    }
  }

  const assignmentStatuses = new Set(['draft', 'confirmed', 'cancelled']);
  let assignmentsImported = 0;
  let assignmentsSkipped = 0;
  for (const row of assignments) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const employeeId = optionalId(row.employee_id, refs.users);
    const locationId = optionalId(row.location_id, knownLocations);
    const startDate = asString(row.start_date);
    const endDate = asString(row.end_date);
    const statusRaw = asString(row.status) ?? 'draft';
    if (
      !id ||
      !organizationId ||
      !employeeId ||
      !locationId ||
      !startDate ||
      !endDate
    ) {
      assignmentsSkipped += 1;
      continue;
    }
    if (!apply) {
      assignmentsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO location_planner.employee_assignments (
          id, organization_id, employee_id, slot_id, location_id, temporary_role_id,
          start_date, end_date, start_time, end_time, status, notes,
          created_by, confirmed_at, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7::date,$8::date,$9::time,$10::time,$11,$12,
          $13,$14::timestamptz,
          COALESCE($15::timestamptz, NOW()), COALESCE($16::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          slot_id = EXCLUDED.slot_id,
          location_id = EXCLUDED.location_id,
          temporary_role_id = EXCLUDED.temporary_role_id,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          status = EXCLUDED.status,
          notes = EXCLUDED.notes,
          confirmed_at = EXCLUDED.confirmed_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        employeeId,
        optionalId(row.slot_id, knownSlots),
        locationId,
        optionalId(row.temporary_role_id, knownRoles),
        startDate,
        endDate,
        asString(row.start_time),
        asString(row.end_time),
        assignmentStatuses.has(statusRaw) ? statusRaw : 'draft',
        asString(row.notes),
        optionalId(row.created_by, refs.users),
        asString(row.confirmed_at),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    assignmentsImported += 1;
  }

  let skillsImported = 0;
  let skillsSkipped = 0;
  for (const row of skills) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const employeeId = optionalId(row.employee_id, refs.users);
    const skill = asString(row.skill)?.trim();
    if (!id || !organizationId || !employeeId || !skill) {
      skillsSkipped += 1;
      continue;
    }
    if (!apply) {
      skillsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO location_planner.employee_skills (
          id, organization_id, employee_id, skill, created_at
        )
        VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz, NOW()))
        ON CONFLICT (organization_id, employee_id, skill) DO NOTHING
      `,
      [
        id,
        organizationId,
        employeeId,
        skill,
        asString(row.created_at),
      ],
    );
    skillsImported += 1;
  }

  let offDaysImported = 0;
  let offDaysSkipped = 0;
  for (const row of offDays) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const employeeId = optionalId(row.user_id, refs.users);
    const offDate = asString(row.off_date);
    if (!id || !organizationId || !employeeId || !offDate) {
      offDaysSkipped += 1;
      continue;
    }
    if (!apply) {
      offDaysImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO location_planner.tlb_off_days (
          id, organization_id, employee_id, off_date, reason, created_by, created_at
        )
        VALUES (
          $1,$2,$3,$4::date,$5,$6,COALESCE($7::timestamptz, NOW())
        )
        ON CONFLICT (organization_id, employee_id, off_date) DO UPDATE SET
          reason = EXCLUDED.reason
      `,
      [
        id,
        organizationId,
        employeeId,
        offDate,
        asString(row.reason),
        optionalId(row.created_by, refs.users),
        asString(row.created_at),
      ],
    );
    offDaysImported += 1;
  }

  let weeklyImported = 0;
  let weeklySkipped = 0;
  for (const row of weeklyOffDays) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const employeeId = optionalId(row.user_id, refs.users);
    // Supabase uses 1-7 (Mon-Sun / ISO-style). Kode weekday is 0-6 (Sun=0).
    const dayOfWeek = asNumber(row.day_of_week, -1);
    const weekday =
      dayOfWeek >= 1 && dayOfWeek <= 7
        ? dayOfWeek % 7
        : dayOfWeek >= 0 && dayOfWeek <= 6
          ? dayOfWeek
          : -1;
    if (!id || !organizationId || !employeeId || weekday < 0) {
      weeklySkipped += 1;
      continue;
    }
    if (!apply) {
      weeklyImported += 1;
      continue;
    }
    const endDate = asString(row.end_date);
    const isActive = !endDate || endDate >= new Date().toISOString().slice(0, 10);
    await client.query(
      `
        INSERT INTO location_planner.tlb_weekly_off_days (
          id, organization_id, employee_id, weekday, reason, is_active,
          created_by, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,COALESCE($8::timestamptz, NOW()), COALESCE($9::timestamptz, NOW())
        )
        ON CONFLICT (organization_id, employee_id, weekday) DO UPDATE SET
          reason = EXCLUDED.reason,
          is_active = EXCLUDED.is_active,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        employeeId,
        weekday,
        asString(row.reason),
        isActive,
        optionalId(row.created_by, refs.users),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    weeklyImported += 1;
  }

  return {
    locationsImported,
    locationsSkipped,
    rolesImported,
    rolesSkipped,
    statusEventsImported,
    statusEventsSkipped,
    slotsImported,
    slotsSkipped,
    assignmentsImported,
    assignmentsSkipped,
    skillsImported,
    skillsSkipped,
    offDaysImported,
    offDaysSkipped,
    weeklyImported,
    weeklySkipped,
  };
}

async function main() {
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (only.size > 0) log(`Only: ${[...only].join(', ')}`);

  const client = await db.connect();
  try {
    const refs = await loadRefs(client);
    log(
      `Refs orgs=${refs.organizations.size} users=${refs.users.size} cards=${refs.cards.size} offices=${refs.offices.size}`,
    );

    if (apply) await client.query('BEGIN');

    if (want('shoots')) {
      const result = await migrateFleetAndShoots(client, refs);
      log(`Shoots ${JSON.stringify(result)}`);
    }
    if (want('obligations')) {
      const result = await migrateObligations(client, refs);
      log(`Obligations ${JSON.stringify(result)}`);
    }
    if (want('security')) {
      const result = await migrateSecurity(client, refs);
      log(`Security ${JSON.stringify(result)}`);
    }
    if (want('attendance')) {
      const result = await migrateAttendance(client, refs);
      log(`Attendance ${JSON.stringify(result)}`);
    }
    if (want('time-entries')) {
      const result = await migrateTimeEntries(client, refs);
      log(`Time entries ${JSON.stringify(result)}`);
    }
    if (want('tickets')) {
      const result = await migrateTickets(client, refs);
      log(`Tickets ${JSON.stringify(result)}`);
    }
    if (want('location-planner')) {
      const result = await migrateLocationPlanner(client, refs);
      log(`Location planner ${JSON.stringify(result)}`);
    }

    if (apply) await client.query('COMMIT');
    else log('Dry run complete. No target data was written.');
  } catch (error) {
    if (apply) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
    }
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
