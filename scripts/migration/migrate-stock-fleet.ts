/**
 * Import stock assets + fleet ops data from live Supabase REST into Kode.
 *
 * Usage:
 *   npx tsx scripts/migration/migrate-stock-fleet.ts
 *   npx tsx scripts/migration/migrate-stock-fleet.ts --apply
 *   npx tsx scripts/migration/migrate-stock-fleet.ts --apply --only=stock
 *   npx tsx scripts/migration/migrate-stock-fleet.ts --apply --only=fleet,shoots
 *
 * Requires LEGACY_STORAGE_URL + LEGACY_STORAGE_SERVICE_ROLE_KEY (or SUPABASE_*).
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
  console.log(`[stock-fleet] ${message}`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

async function loadRefs(client: PoolClient) {
  const [orgs, users, offices] = await Promise.all([
    client.query<{ id: string }>('SELECT id FROM organizations.organizations'),
    client.query<{ id: string }>('SELECT id FROM identity.users'),
    client.query<{ id: string }>('SELECT id FROM organizations.offices'),
  ]);
  return {
    organizations: new Set(orgs.rows.map((row) => row.id)),
    users: new Set(users.rows.map((row) => row.id)),
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

const ASSET_STATUSES = new Set([
  'in_stock',
  'assigned',
  'in_repair',
  'retired',
  'lost',
  'disposed',
]);
const ASSET_CONDITIONS = new Set([
  'new',
  'excellent',
  'good',
  'fair',
  'damaged',
]);
const ASSIGNMENT_STATUSES = new Set([
  'active',
  'returned',
  'overdue',
  'cancelled',
]);

async function migrateStock(client: PoolClient, refs: Refs) {
  const categories = await fetchAllRows('asset_categories');
  const locations = await fetchAllRows('stock_locations');
  const batches = await fetchAllRows('purchase_batches');
  const assets = await fetchAllRows('assets');
  const assignments = await fetchAllRows('asset_assignments');
  log(
    `Fetched categories=${categories.length} locations=${locations.length} batches=${batches.length} assets=${assets.length} assignments=${assignments.length}`,
  );

  let categoriesImported = 0;
  let locationsImported = 0;
  let batchesImported = 0;
  let assetsImported = 0;
  let assetsSkipped = 0;
  let assignmentsImported = 0;
  let assignmentsSkipped = 0;

  for (const row of categories) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const name = asString(row.name)?.trim();
    if (!id || !organizationId || !name) continue;
    if (!apply) {
      categoriesImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO stock.categories (id, organization_id, name, created_at, updated_at)
        VALUES ($1,$2,$3,COALESCE($4::timestamptz, NOW()), COALESCE($5::timestamptz, NOW()))
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        name,
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    categoriesImported += 1;
  }

  for (const row of locations) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const name = asString(row.name)?.trim();
    if (!id || !organizationId || !name) continue;
    if (!apply) {
      locationsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO stock.locations (
          id, organization_id, name, code, image_url, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, NOW()), COALESCE($7::timestamptz, NOW()))
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          code = EXCLUDED.code,
          image_url = EXCLUDED.image_url,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        name,
        asString(row.code),
        asString(row.image_url),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    locationsImported += 1;
  }

  for (const row of batches) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    if (!id || !organizationId) continue;
    if (!apply) {
      batchesImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO stock.purchase_batches (
          id, organization_id, reference_number, invoice_number, purchase_date,
          vendor_id, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5::date,$6,COALESCE($7::timestamptz, NOW()), COALESCE($8::timestamptz, NOW()))
        ON CONFLICT (id) DO UPDATE SET
          reference_number = EXCLUDED.reference_number,
          invoice_number = EXCLUDED.invoice_number,
          purchase_date = EXCLUDED.purchase_date,
          vendor_id = EXCLUDED.vendor_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        asString(row.reference_number),
        asString(row.invoice_number),
        asString(row.purchase_date),
        asString(row.vendor_id),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    batchesImported += 1;
  }

  const knownCategories = new Set(
    apply
      ? (
          await client.query<{ id: string }>('SELECT id FROM stock.categories')
        ).rows.map((row) => row.id)
      : categories.map((row) => asString(row.id)).filter(Boolean) as string[],
  );
  const knownLocations = new Set(
    apply
      ? (
          await client.query<{ id: string }>('SELECT id FROM stock.locations')
        ).rows.map((row) => row.id)
      : locations.map((row) => asString(row.id)).filter(Boolean) as string[],
  );
  const knownBatches = new Set(
    apply
      ? (
          await client.query<{ id: string }>(
            'SELECT id FROM stock.purchase_batches',
          )
        ).rows.map((row) => row.id)
      : batches.map((row) => asString(row.id)).filter(Boolean) as string[],
  );

  for (const row of assets) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const assetName = asString(row.asset_name)?.trim();
    const serialNumber = asString(row.serial_number)?.trim();
    if (!id || !organizationId || !assetName || !serialNumber) {
      assetsSkipped += 1;
      continue;
    }
    const statusRaw = asString(row.status) ?? 'in_stock';
    const status = ASSET_STATUSES.has(statusRaw) ? statusRaw : 'in_stock';
    const conditionRaw = asString(row.condition) ?? 'new';
    const condition = ASSET_CONDITIONS.has(conditionRaw)
      ? conditionRaw
      : 'new';

    if (!apply) {
      assetsImported += 1;
      continue;
    }

    await client.query(
      `
        INSERT INTO stock.assets (
          id, organization_id, purchase_batch_id, category_id, current_location_id,
          asset_name, asset_tag, serial_number, brand, model, description,
          status, condition, purchase_price, currency, purchase_date,
          warranty_expiry_date, expected_life_months, invoice_number, reference_number,
          insured, insurance_provider, insurance_policy_number, insurance_expiry_date,
          sub_location, barcode_value, qr_code_value, asset_image_url, site_image_url,
          asset_image_width, asset_image_height, site_image_width, site_image_height,
          notes, assigned_to, assigned_project_id, created_by, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16::date,
          $17::date,$18,$19,$20,
          $21,$22,$23,$24::date,
          $25,$26,$27,$28,$29,
          $30,$31,$32,$33,
          $34,$35,$36,$37,COALESCE($38::timestamptz, NOW()), COALESCE($39::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          purchase_batch_id = EXCLUDED.purchase_batch_id,
          category_id = EXCLUDED.category_id,
          current_location_id = EXCLUDED.current_location_id,
          asset_name = EXCLUDED.asset_name,
          asset_tag = EXCLUDED.asset_tag,
          serial_number = EXCLUDED.serial_number,
          brand = EXCLUDED.brand,
          model = EXCLUDED.model,
          description = EXCLUDED.description,
          status = EXCLUDED.status,
          condition = EXCLUDED.condition,
          purchase_price = EXCLUDED.purchase_price,
          currency = EXCLUDED.currency,
          purchase_date = EXCLUDED.purchase_date,
          warranty_expiry_date = EXCLUDED.warranty_expiry_date,
          expected_life_months = EXCLUDED.expected_life_months,
          invoice_number = EXCLUDED.invoice_number,
          reference_number = EXCLUDED.reference_number,
          insured = EXCLUDED.insured,
          insurance_provider = EXCLUDED.insurance_provider,
          insurance_policy_number = EXCLUDED.insurance_policy_number,
          insurance_expiry_date = EXCLUDED.insurance_expiry_date,
          sub_location = EXCLUDED.sub_location,
          barcode_value = EXCLUDED.barcode_value,
          qr_code_value = EXCLUDED.qr_code_value,
          asset_image_url = EXCLUDED.asset_image_url,
          site_image_url = EXCLUDED.site_image_url,
          asset_image_width = EXCLUDED.asset_image_width,
          asset_image_height = EXCLUDED.asset_image_height,
          site_image_width = EXCLUDED.site_image_width,
          site_image_height = EXCLUDED.site_image_height,
          notes = EXCLUDED.notes,
          assigned_to = EXCLUDED.assigned_to,
          assigned_project_id = EXCLUDED.assigned_project_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        optionalId(row.purchase_batch_id, knownBatches),
        optionalId(row.category_id, knownCategories),
        optionalId(row.current_location_id, knownLocations),
        assetName,
        asString(row.asset_tag),
        serialNumber,
        asString(row.brand),
        asString(row.model),
        asString(row.description),
        status,
        condition,
        row.purchase_price == null ? null : asNumber(row.purchase_price),
        asString(row.currency) ?? 'USD',
        asString(row.purchase_date),
        asString(row.warranty_expiry_date),
        row.expected_life_months == null
          ? null
          : asNumber(row.expected_life_months),
        asString(row.invoice_number),
        asString(row.reference_number),
        asBoolean(row.insured),
        asString(row.insurance_provider),
        asString(row.insurance_policy_number),
        asString(row.insurance_expiry_date),
        asString(row.sub_location),
        asString(row.barcode_value),
        asString(row.qr_code_value),
        asString(row.asset_image_url),
        asString(row.site_image_url),
        row.asset_image_width == null ? null : asNumber(row.asset_image_width),
        row.asset_image_height == null
          ? null
          : asNumber(row.asset_image_height),
        row.site_image_width == null ? null : asNumber(row.site_image_width),
        row.site_image_height == null ? null : asNumber(row.site_image_height),
        asString(row.notes),
        optionalId(row.assigned_to, refs.users),
        asString(row.assigned_project_id),
        optionalId(row.created_by, refs.users),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    assetsImported += 1;
  }

  const knownAssets = new Set(
    apply
      ? (
          await client.query<{ id: string }>('SELECT id FROM stock.assets')
        ).rows.map((row) => row.id)
      : assets.map((row) => asString(row.id)).filter(Boolean) as string[],
  );

  for (const row of assignments) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const assetId = optionalId(row.asset_id, knownAssets);
    if (!id || !organizationId || !assetId) {
      assignmentsSkipped += 1;
      continue;
    }
    const statusRaw = asString(row.status) ?? 'active';
    const status = ASSIGNMENT_STATUSES.has(statusRaw) ? statusRaw : 'active';
    if (!apply) {
      assignmentsImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO stock.asset_assignments (
          id, organization_id, asset_id, assigned_to, assigned_project_id,
          assigned_location_id, assigned_by, assigned_at, due_back_at,
          returned_at, returned_by, status, notes, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,COALESCE($8::timestamptz, NOW()),$9::timestamptz,
          $10::timestamptz,$11,$12,$13,COALESCE($14::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          assigned_to = EXCLUDED.assigned_to,
          assigned_project_id = EXCLUDED.assigned_project_id,
          assigned_location_id = EXCLUDED.assigned_location_id,
          assigned_by = EXCLUDED.assigned_by,
          assigned_at = EXCLUDED.assigned_at,
          due_back_at = EXCLUDED.due_back_at,
          returned_at = EXCLUDED.returned_at,
          returned_by = EXCLUDED.returned_by,
          status = EXCLUDED.status,
          notes = EXCLUDED.notes
      `,
      [
        id,
        organizationId,
        assetId,
        optionalId(row.assigned_to, refs.users),
        asString(row.assigned_project_id),
        optionalId(row.assigned_location_id, knownLocations),
        optionalId(row.assigned_by, refs.users),
        asString(row.assigned_at),
        asString(row.due_back_at),
        asString(row.returned_at),
        optionalId(row.returned_by, refs.users),
        status,
        asString(row.notes),
        asString(row.created_at),
      ],
    );
    assignmentsImported += 1;
  }

  return {
    categoriesImported,
    locationsImported,
    batchesImported,
    assetsImported,
    assetsSkipped,
    assignmentsImported,
    assignmentsSkipped,
  };
}

async function migrateFleetOps(client: PoolClient, refs: Refs) {
  const vehicles = await fetchAllRows('fleet_vehicles');
  const summaries = await fetchAllRows('fleet_daily_summaries');
  const fuel = await fetchAllRows('fleet_fuel_purchases');
  const maintenance = await fetchAllRows('fleet_maintenance_records');
  const batches = await fetchAllRows('fleet_import_batches');
  const importRows = await fetchAllRows('fleet_import_rows');
  log(
    `Fetched fleet vehicles=${vehicles.length} summaries=${summaries.length} fuel=${fuel.length} maintenance=${maintenance.length} batches=${batches.length} importRows=${importRows.length}`,
  );

  let vehiclesImported = 0;
  let vehiclesSkipped = 0;
  let summariesImported = 0;
  let summariesSkipped = 0;
  let fuelImported = 0;
  let fuelSkipped = 0;
  let maintenanceImported = 0;
  let maintenanceSkipped = 0;
  let batchesImported = 0;
  let importRowsImported = 0;
  let importRowsSkipped = 0;

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
        INSERT INTO fleet.vehicles (
          id, organization_id, office_id, vehicle_name, registration_number,
          current_odometer_km, last_service_date, last_service_odometer_km,
          next_service_date, next_service_odometer_km, service_interval_km,
          service_status, estimated_days_to_service, latest_odometer_at,
          status, maintenance_note, maintenance_started_at, maintenance_started_by,
          ezitrack_import_paused, ezitrack_resumed_at, ezitrack_resumed_import_batch_id,
          created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7::date,$8,
          $9::date,$10,$11,
          $12,$13,$14::timestamptz,
          COALESCE(NULLIF($15,''),'active'),$16,$17::timestamptz,$18,
          $19,$20::timestamptz,$21,
          COALESCE($22::timestamptz, NOW()), COALESCE($23::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          office_id = EXCLUDED.office_id,
          vehicle_name = EXCLUDED.vehicle_name,
          registration_number = EXCLUDED.registration_number,
          current_odometer_km = EXCLUDED.current_odometer_km,
          last_service_date = EXCLUDED.last_service_date,
          last_service_odometer_km = EXCLUDED.last_service_odometer_km,
          next_service_date = EXCLUDED.next_service_date,
          next_service_odometer_km = EXCLUDED.next_service_odometer_km,
          service_interval_km = EXCLUDED.service_interval_km,
          service_status = EXCLUDED.service_status,
          estimated_days_to_service = EXCLUDED.estimated_days_to_service,
          latest_odometer_at = EXCLUDED.latest_odometer_at,
          status = EXCLUDED.status,
          maintenance_note = EXCLUDED.maintenance_note,
          maintenance_started_at = EXCLUDED.maintenance_started_at,
          maintenance_started_by = EXCLUDED.maintenance_started_by,
          ezitrack_import_paused = EXCLUDED.ezitrack_import_paused,
          ezitrack_resumed_at = EXCLUDED.ezitrack_resumed_at,
          ezitrack_resumed_import_batch_id = EXCLUDED.ezitrack_resumed_import_batch_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        optionalId(row.office_id, refs.offices),
        asString(row.vehicle_name),
        asString(row.registration_number),
        row.current_odometer_km == null
          ? null
          : asNumber(row.current_odometer_km),
        asString(row.last_service_date),
        row.last_service_odometer_km == null
          ? null
          : asNumber(row.last_service_odometer_km),
        asString(row.next_service_date),
        row.next_service_odometer_km == null
          ? null
          : asNumber(row.next_service_odometer_km),
        row.service_interval_km == null
          ? null
          : asNumber(row.service_interval_km),
        asString(row.service_status),
        row.estimated_days_to_service == null
          ? null
          : asNumber(row.estimated_days_to_service),
        asString(row.latest_odometer_at),
        asString(row.status) ?? 'active',
        asString(row.maintenance_note),
        asString(row.maintenance_started_at),
        optionalId(row.maintenance_started_by, refs.users),
        asBoolean(row.ezitrack_import_paused),
        asString(row.ezitrack_resumed_at),
        asString(row.ezitrack_resumed_import_batch_id),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    vehiclesImported += 1;
  }

  const knownVehicles = new Set(
    apply
      ? (
          await client.query<{ id: string }>('SELECT id FROM fleet.vehicles')
        ).rows.map((row) => row.id)
      : vehicles.map((row) => asString(row.id)).filter(Boolean) as string[],
  );

  for (const row of summaries) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const vehicleId = optionalId(row.vehicle_id, knownVehicles);
    const summaryDate = asString(row.summary_date);
    if (!id || !organizationId || !vehicleId || !summaryDate) {
      summariesSkipped += 1;
      continue;
    }
    if (!apply) {
      summariesImported += 1;
      continue;
    }
    const raw = asJson(row.raw_data, {}) as Record<string, unknown>;
    const enriched = {
      ...raw,
      period_start: row.period_start ?? null,
      period_end: row.period_end ?? null,
      route_start: row.route_start ?? null,
      route_end: row.route_end ?? null,
    };
    await client.query(
      `
        INSERT INTO fleet.daily_summaries (
          id, organization_id, vehicle_id, summary_date, source,
          route_length_km, move_duration_seconds, stop_duration_seconds, stop_count,
          top_speed_kmh, average_speed_kmh, overspeed_count,
          fuel_consumption_litres, average_fuel_consumption_per_100km, fuel_cost, currency,
          engine_work_seconds, engine_idle_seconds, odometer_km, engine_hours_seconds,
          driver_name, raw_data, imported_at, created_at
        )
        VALUES (
          $1,$2,$3,$4::date,COALESCE(NULLIF($5,''),'ezitrack_email'),
          $6,$7,$8,$9,
          $10,$11,$12,
          $13,$14,$15,COALESCE(NULLIF($16,''),'USD'),
          $17,$18,$19,$20,
          $21,$22::jsonb,COALESCE($23::timestamptz, NOW()), COALESCE($24::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          route_length_km = EXCLUDED.route_length_km,
          move_duration_seconds = EXCLUDED.move_duration_seconds,
          stop_duration_seconds = EXCLUDED.stop_duration_seconds,
          stop_count = EXCLUDED.stop_count,
          top_speed_kmh = EXCLUDED.top_speed_kmh,
          average_speed_kmh = EXCLUDED.average_speed_kmh,
          overspeed_count = EXCLUDED.overspeed_count,
          fuel_consumption_litres = EXCLUDED.fuel_consumption_litres,
          average_fuel_consumption_per_100km = EXCLUDED.average_fuel_consumption_per_100km,
          fuel_cost = EXCLUDED.fuel_cost,
          currency = EXCLUDED.currency,
          engine_work_seconds = EXCLUDED.engine_work_seconds,
          engine_idle_seconds = EXCLUDED.engine_idle_seconds,
          odometer_km = EXCLUDED.odometer_km,
          engine_hours_seconds = EXCLUDED.engine_hours_seconds,
          driver_name = EXCLUDED.driver_name,
          raw_data = EXCLUDED.raw_data,
          imported_at = EXCLUDED.imported_at
      `,
      [
        id,
        organizationId,
        vehicleId,
        summaryDate,
        asString(row.source),
        asNumber(row.route_length_km),
        asNumber(row.move_duration_seconds),
        asNumber(row.stop_duration_seconds),
        asNumber(row.stop_count),
        row.top_speed_kmh == null ? null : asNumber(row.top_speed_kmh),
        row.average_speed_kmh == null ? null : asNumber(row.average_speed_kmh),
        asNumber(row.overspeed_count),
        row.fuel_consumption_litres == null
          ? null
          : asNumber(row.fuel_consumption_litres),
        row.average_fuel_consumption_per_100km == null
          ? null
          : asNumber(row.average_fuel_consumption_per_100km),
        row.fuel_cost == null ? null : asNumber(row.fuel_cost),
        asString(row.currency),
        asNumber(row.engine_work_seconds),
        asNumber(row.engine_idle_seconds),
        row.odometer_km == null ? null : asNumber(row.odometer_km),
        asNumber(row.engine_hours_seconds),
        asString(row.driver_name),
        JSON.stringify(enriched),
        asString(row.imported_at),
        asString(row.created_at),
      ],
    );
    summariesImported += 1;
  }

  for (const row of fuel) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const vehicleId = optionalId(row.vehicle_id, knownVehicles);
    const purchaseDate = asString(row.purchase_date);
    const litres = asNumber(row.litres);
    const totalCost = asNumber(row.total_cost);
    if (!id || !organizationId || !vehicleId || !purchaseDate || litres <= 0) {
      fuelSkipped += 1;
      continue;
    }
    if (!apply) {
      fuelImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO fleet.fuel_purchases (
          id, organization_id, vehicle_id, purchase_date, litres, unit_price,
          total_cost, currency, odometer_km, station_name, payment_method,
          receipt_number, receipt_url, recorded_by, notes, created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4::timestamptz,$5,$6,
          $7,COALESCE(NULLIF($8,''),'USD'),$9,$10,$11,
          $12,$13,$14,$15,COALESCE($16::timestamptz, NOW()), COALESCE($17::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          purchase_date = EXCLUDED.purchase_date,
          litres = EXCLUDED.litres,
          unit_price = EXCLUDED.unit_price,
          total_cost = EXCLUDED.total_cost,
          currency = EXCLUDED.currency,
          odometer_km = EXCLUDED.odometer_km,
          station_name = EXCLUDED.station_name,
          payment_method = EXCLUDED.payment_method,
          receipt_number = EXCLUDED.receipt_number,
          receipt_url = EXCLUDED.receipt_url,
          notes = EXCLUDED.notes,
          updated_at = EXCLUDED.updated_at
      `,
      [
        id,
        organizationId,
        vehicleId,
        purchaseDate,
        litres,
        row.unit_price == null ? null : asNumber(row.unit_price),
        Math.max(0, totalCost),
        asString(row.currency),
        row.odometer_km == null ? null : asNumber(row.odometer_km),
        asString(row.station_name),
        asString(row.payment_method),
        asString(row.receipt_number),
        asString(row.receipt_url),
        optionalId(row.recorded_by, refs.users),
        asString(row.notes),
        asString(row.created_at),
        asString(row.updated_at),
      ],
    );
    fuelImported += 1;
  }

  for (const row of maintenance) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const vehicleId = optionalId(row.vehicle_id, knownVehicles);
    const serviceDate = asString(row.service_date);
    if (!id || !organizationId || !vehicleId || !serviceDate) {
      maintenanceSkipped += 1;
      continue;
    }
    if (!apply) {
      maintenanceImported += 1;
      continue;
    }
    await client.query(
      `
        INSERT INTO fleet.maintenance_records (
          id, organization_id, vehicle_id, service_date, odometer_km, service_type,
          description, provider, cost, currency, invoice_url,
          next_service_date, next_service_odometer_km, created_by, created_at
        )
        VALUES (
          $1,$2,$3,$4::date,$5,COALESCE(NULLIF($6,''),'service'),
          $7,$8,$9,COALESCE(NULLIF($10,''),'USD'),$11,
          $12::date,$13,$14,COALESCE($15::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          service_date = EXCLUDED.service_date,
          odometer_km = EXCLUDED.odometer_km,
          service_type = EXCLUDED.service_type,
          description = EXCLUDED.description,
          provider = EXCLUDED.provider,
          cost = EXCLUDED.cost,
          currency = EXCLUDED.currency,
          invoice_url = EXCLUDED.invoice_url,
          next_service_date = EXCLUDED.next_service_date,
          next_service_odometer_km = EXCLUDED.next_service_odometer_km
      `,
      [
        id,
        organizationId,
        vehicleId,
        serviceDate,
        row.odometer_km == null ? null : asNumber(row.odometer_km),
        asString(row.service_type),
        asString(row.description),
        asString(row.provider),
        row.cost == null ? null : asNumber(row.cost),
        asString(row.currency),
        asString(row.invoice_url),
        asString(row.next_service_date),
        row.next_service_odometer_km == null
          ? null
          : asNumber(row.next_service_odometer_km),
        optionalId(row.created_by, refs.users),
        asString(row.created_at),
      ],
    );
    maintenanceImported += 1;
  }

  for (const row of batches) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    if (!id || !organizationId) continue;
    if (!apply) {
      batchesImported += 1;
      continue;
    }
    const statusRaw = asString(row.status) ?? 'completed';
    const status = ['processing', 'completed', 'partial_failed', 'failed'].includes(
      statusRaw,
    )
      ? statusRaw
      : 'completed';
    await client.query(
      `
        INSERT INTO fleet.import_batches (
          id, organization_id, source, import_type, file_name, status,
          total_rows, imported_rows, failed_rows, created_by, created_at,
          completed_at, metadata
        )
        VALUES (
          $1,$2,COALESCE(NULLIF($3,''),'ezitrack_email'),COALESCE(NULLIF($4,''),'daily_report'),$5,$6,
          $7,$8,$9,$10,COALESCE($11::timestamptz, NOW()),
          $12::timestamptz,$13::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          total_rows = EXCLUDED.total_rows,
          imported_rows = EXCLUDED.imported_rows,
          failed_rows = EXCLUDED.failed_rows,
          completed_at = EXCLUDED.completed_at,
          metadata = EXCLUDED.metadata
      `,
      [
        id,
        organizationId,
        asString(row.source),
        asString(row.import_type),
        asString(row.file_name),
        status,
        asNumber(row.total_rows),
        asNumber(row.imported_rows),
        asNumber(row.failed_rows),
        optionalId(row.created_by, refs.users),
        asString(row.created_at),
        asString(row.completed_at),
        JSON.stringify(asJson(row.metadata, {})),
      ],
    );
    batchesImported += 1;
  }

  const knownBatches = new Set(
    apply
      ? (
          await client.query<{ id: string }>(
            'SELECT id FROM fleet.import_batches',
          )
        ).rows.map((row) => row.id)
      : batches.map((row) => asString(row.id)).filter(Boolean) as string[],
  );

  for (const row of importRows) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    const batchId = optionalId(row.batch_id, knownBatches);
    if (!id || !organizationId || !batchId) {
      importRowsSkipped += 1;
      continue;
    }
    if (!apply) {
      importRowsImported += 1;
      continue;
    }
    const statusRaw = asString(row.status) ?? 'imported';
    const status = [
      'pending',
      'imported',
      'failed',
      'unmatched',
      'skipped_maintenance',
    ].includes(statusRaw)
      ? statusRaw
      : 'imported';
    await client.query(
      `
        INSERT INTO fleet.import_rows (
          id, organization_id, batch_id, row_number, raw_data, mapped_data,
          vehicle_id, status, error_message, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5::jsonb,$6::jsonb,
          $7,$8,$9,COALESCE($10::timestamptz, NOW())
        )
        ON CONFLICT (id) DO UPDATE SET
          raw_data = EXCLUDED.raw_data,
          mapped_data = EXCLUDED.mapped_data,
          vehicle_id = EXCLUDED.vehicle_id,
          status = EXCLUDED.status,
          error_message = EXCLUDED.error_message
      `,
      [
        id,
        organizationId,
        batchId,
        asNumber(row.row_number),
        JSON.stringify(asJson(row.raw_data, {})),
        JSON.stringify(asJson(row.mapped_data, {})),
        optionalId(row.vehicle_id, knownVehicles),
        status,
        asString(row.error_message),
        asString(row.created_at),
      ],
    );
    importRowsImported += 1;
  }

  return {
    vehiclesImported,
    vehiclesSkipped,
    summariesImported,
    summariesSkipped,
    fuelImported,
    fuelSkipped,
    maintenanceImported,
    maintenanceSkipped,
    batchesImported,
    importRowsImported,
    importRowsSkipped,
  };
}

async function migrateMediaFleetShoots(client: PoolClient, refs: Refs) {
  const vehicles = await fetchAllRows('fleet_vehicles');
  const bookings = await fetchAllRows('shoot_bookings');
  log(
    `Fetched media fleet_vehicles=${vehicles.length} shoot_bookings=${bookings.length}`,
  );

  let vehiclesImported = 0;
  let bookingsImported = 0;
  let bookingsSkipped = 0;

  for (const row of vehicles) {
    const id = asString(row.id);
    const organizationId = requireOrg(row, refs);
    if (!id || !organizationId) continue;
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
    apply
      ? (
          await client.query<{ id: string }>(
            'SELECT id FROM media.fleet_vehicles',
          )
        ).rows.map((row) => row.id)
      : vehicles.map((row) => asString(row.id)).filter(Boolean) as string[],
  );

  const statuses = new Set(['pending', 'approved', 'rejected', 'cancelled']);
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

  return { vehiclesImported, bookingsImported, bookingsSkipped };
}

async function main() {
  log(apply ? 'APPLY mode' : 'Dry run');
  if (only.size > 0) log(`Only: ${[...only].join(', ')}`);

  const client = await db.connect();
  try {
    const refs = await loadRefs(client);
    log(
      `Refs orgs=${refs.organizations.size} users=${refs.users.size} offices=${refs.offices.size}`,
    );

    if (apply) await client.query('BEGIN');

    if (want('stock')) {
      const result = await migrateStock(client, refs);
      log(`Stock ${JSON.stringify(result)}`);
    }
    if (want('fleet')) {
      const result = await migrateFleetOps(client, refs);
      log(`Fleet ${JSON.stringify(result)}`);
    }
    if (want('shoots')) {
      const result = await migrateMediaFleetShoots(client, refs);
      log(`Shoots ${JSON.stringify(result)}`);
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
