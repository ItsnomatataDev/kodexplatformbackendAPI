import { listLimit } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

function n(v: unknown) {
  if (v === null || v === undefined || v === '') return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

/** Serialize a Postgres DATE (or date-like) as YYYY-MM-DD for the FE. */
function asDateOnly(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function asIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapVehicle(row: Record<string, unknown>) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    office_id: row.office_id ?? null,
    vehicle_name: row.vehicle_name ?? null,
    registration_number: row.registration_number ?? null,
    current_odometer_km: n(row.current_odometer_km),
    last_service_date: asDateOnly(row.last_service_date),
    last_service_odometer_km: n(row.last_service_odometer_km),
    next_service_date: asDateOnly(row.next_service_date),
    next_service_odometer_km: n(row.next_service_odometer_km),
    service_interval_km: n(row.service_interval_km),
    service_status: row.service_status ?? null,
    estimated_days_to_service: n(row.estimated_days_to_service),
    latest_odometer_at: asIso(row.latest_odometer_at),
    last_latitude: n(row.last_latitude),
    last_longitude: n(row.last_longitude),
    last_location_at: asIso(row.last_location_at),
    last_location_source: row.last_location_source ?? null,
    status: row.status ?? null,
    maintenance_note: row.maintenance_note ?? null,
    maintenance_started_at: asIso(row.maintenance_started_at),
    ezitrack_import_paused: Boolean(row.ezitrack_import_paused),
    ezitrack_resumed_at: asIso(row.ezitrack_resumed_at),
    created_at: asIso(row.created_at),
    office: row.office_id
      ? { id: row.office_id, name: row.office_name ?? null, slug: row.office_slug ?? null }
      : null,
  };
}

function mapFuel(row: Record<string, unknown>) {
  return {
    ...row,
    purchase_date: asDateOnly(row.purchase_date),
    litres: n(row.litres),
    unit_price: n(row.unit_price),
    total_cost: n(row.total_cost),
    odometer_km: n(row.odometer_km),
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    vehicle: {
      id: row.vehicle_id,
      vehicle_name: row.vehicle_name ?? null,
      registration_number: row.registration_number ?? null,
    },
  };
}

function mapMaintenance(row: Record<string, unknown>) {
  return {
    ...row,
    service_date: asDateOnly(row.service_date),
    next_service_date: asDateOnly(row.next_service_date),
    odometer_km: n(row.odometer_km),
    cost: n(row.cost),
    next_service_odometer_km: n(row.next_service_odometer_km),
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    vehicle: {
      id: row.vehicle_id,
      vehicle_name: row.vehicle_name ?? null,
      registration_number: row.registration_number ?? null,
    },
  };
}

function mapSchedule(row: Record<string, unknown>) {
  return {
    ...row,
    last_service_date: asDateOnly(row.last_service_date),
    next_service_date: asDateOnly(row.next_service_date),
    last_service_odometer_km: n(row.last_service_odometer_km),
    next_service_odometer_km: n(row.next_service_odometer_km),
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    vehicle: {
      id: row.vehicle_id,
      vehicle_name: row.vehicle_name ?? null,
      registration_number: row.registration_number ?? null,
    },
  };
}

export class PostgresFleetStore {
  async listVehicles(organizationId: string, requestedLimit?: number) {
    const limit = listLimit(requestedLimit);
    const result = await db.query(
      `SELECT v.*, o.name AS office_name, o.slug AS office_slug
       FROM fleet.vehicles v
       LEFT JOIN organizations.offices o ON o.id = v.office_id
       WHERE v.organization_id = $1
       ORDER BY v.vehicle_name ASC NULLS LAST, v.id ASC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map(mapVehicle);
  }

  async getVehicle(organizationId: string, vehicleId: string) {
    const result = await db.query(
      `SELECT v.*, o.name AS office_name, o.slug AS office_slug
       FROM fleet.vehicles v
       LEFT JOIN organizations.offices o ON o.id = v.office_id
       WHERE v.organization_id = $1 AND v.id = $2
       LIMIT 1`,
      [organizationId, vehicleId],
    );
    return result.rows[0] ? mapVehicle(result.rows[0]) : null;
  }

  async createVehicle(input: {
    organizationId: string;
    vehicleName?: string | null;
    registrationNumber?: string | null;
    officeId?: string | null;
    currentOdometerKm?: number | null;
  }) {
    const result = await db.query(
      `INSERT INTO fleet.vehicles (
         organization_id, vehicle_name, registration_number, office_id, current_odometer_km, status
       ) VALUES ($1,$2,$3,$4,$5,'active')
       RETURNING id`,
      [
        input.organizationId,
        input.vehicleName ?? null,
        input.registrationNumber ?? null,
        input.officeId ?? null,
        input.currentOdometerKm ?? null,
      ],
    );
    return this.getVehicle(input.organizationId, result.rows[0].id as string);
  }

  async updateVehicle(
    organizationId: string,
    vehicleId: string,
    patch: Record<string, unknown>,
  ) {
    const map: Record<string, string> = {
      vehicleName: 'vehicle_name',
      registrationNumber: 'registration_number',
      officeId: 'office_id',
      currentOdometerKm: 'current_odometer_km',
      status: 'status',
      maintenanceNote: 'maintenance_note',
      maintenanceStartedAt: 'maintenance_started_at',
      maintenanceStartedBy: 'maintenance_started_by',
      ezitrackImportPaused: 'ezitrack_import_paused',
      ezitrackResumedAt: 'ezitrack_resumed_at',
      lastServiceDate: 'last_service_date',
      lastServiceOdometerKm: 'last_service_odometer_km',
      nextServiceDate: 'next_service_date',
      nextServiceOdometerKm: 'next_service_odometer_km',
      serviceIntervalKm: 'service_interval_km',
      serviceStatus: 'service_status',
      estimatedDaysToService: 'estimated_days_to_service',
      latestOdometerAt: 'latest_odometer_at',
      lastLatitude: 'last_latitude',
      lastLongitude: 'last_longitude',
      lastLocationAt: 'last_location_at',
      lastLocationSource: 'last_location_source',
    };
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(patch, key) || Object.prototype.hasOwnProperty.call(patch, column)) {
        values.push(patch[key] ?? patch[column]);
        fields.push(`${column} = $${values.length}`);
      }
    }
    if (!fields.length) throw new ValidationError('No vehicle fields to update.');
    fields.push('updated_at = NOW()');
    values.push(organizationId, vehicleId);
    const result = await db.query(
      `UPDATE fleet.vehicles SET ${fields.join(', ')}
       WHERE organization_id = $${values.length - 1} AND id = $${values.length}
       RETURNING id`,
      values,
    );
    if (!result.rows[0]) throw new NotFoundError('VEHICLE_NOT_FOUND', 'Vehicle not found.');
    return this.getVehicle(organizationId, vehicleId);
  }

  async setMaintenanceMode(params: {
    organizationId: string;
    vehicleId: string;
    underMaintenance: boolean;
    note?: string | null;
    userId?: string | null;
  }) {
    if (params.underMaintenance) {
      return this.updateVehicle(params.organizationId, params.vehicleId, {
        status: 'maintenance',
        ezitrack_import_paused: true,
        maintenance_note: params.note?.trim() || null,
        maintenance_started_at: new Date().toISOString(),
        maintenance_started_by: params.userId ?? null,
        ezitrack_resumed_at: null,
      });
    }
    return this.updateVehicle(params.organizationId, params.vehicleId, {
      status: 'active',
      ezitrack_import_paused: false,
      maintenance_note: null,
      maintenance_started_at: null,
      maintenance_started_by: null,
      ezitrack_resumed_at: new Date().toISOString(),
    });
  }

  async listDailySummaries(organizationId: string, startDate: string, endDate: string) {
    const result = await db.query(
      `SELECT s.*, v.vehicle_name, v.registration_number
       FROM fleet.daily_summaries s
       LEFT JOIN fleet.vehicles v ON v.id = s.vehicle_id
       WHERE s.organization_id = $1
         AND s.summary_date >= $2::date
         AND s.summary_date <= $3::date
       ORDER BY s.summary_date DESC, s.id DESC
       LIMIT 2001`,
      [organizationId, startDate, endDate],
    );
    const summaries = result.rows.slice(0, 2000).map((row) => ({
      ...row,
      summary_date: asDateOnly(row.summary_date),
      route_length_km: Number(row.route_length_km ?? 0),
      imported_at: asIso(row.imported_at),
      created_at: asIso(row.created_at),
      vehicle: {
        id: row.vehicle_id,
        vehicle_name: row.vehicle_name ?? null,
        registration_number: row.registration_number ?? null,
      },
    }));
    return { summaries, hasMore: result.rows.length > 2000 };
  }

  async latestSummaryDate(organizationId: string) {
    const result = await db.query(
      `SELECT summary_date FROM fleet.daily_summaries
       WHERE organization_id = $1
       ORDER BY summary_date DESC LIMIT 1`,
      [organizationId],
    );
    return result.rows[0] ? asDateOnly(result.rows[0].summary_date) : null;
  }

  async listFuel(organizationId: string) {
    const result = await db.query(
      `SELECT f.*, v.vehicle_name, v.registration_number
       FROM fleet.fuel_purchases f
       LEFT JOIN fleet.vehicles v ON v.id = f.vehicle_id
       WHERE f.organization_id = $1
       ORDER BY f.purchase_date DESC LIMIT 120`,
      [organizationId],
    );
    return result.rows.map(mapFuel);
  }

  async createFuel(input: Record<string, unknown> & { organizationId: string }) {
    const result = await db.query(
      `INSERT INTO fleet.fuel_purchases (
         organization_id, vehicle_id, purchase_date, litres, unit_price, total_cost,
         currency, odometer_km, station_name, payment_method, receipt_number,
         receipt_url, recorded_by, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'USD'),$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        input.organizationId,
        input.vehicleId,
        input.purchaseDate,
        input.litres,
        input.unitPrice ?? null,
        input.totalCost,
        input.currency ?? 'USD',
        input.odometerKm ?? null,
        input.stationName ?? null,
        input.paymentMethod ?? null,
        input.receiptNumber ?? null,
        input.receiptUrl ?? null,
        input.recordedBy ?? null,
        input.notes ?? null,
      ],
    );
    return mapFuel(result.rows[0] as Record<string, unknown>);
  }

  async listMaintenance(organizationId: string) {
    const result = await db.query(
      `SELECT m.*, v.vehicle_name, v.registration_number
       FROM fleet.maintenance_records m
       LEFT JOIN fleet.vehicles v ON v.id = m.vehicle_id
       WHERE m.organization_id = $1
       ORDER BY m.service_date DESC LIMIT 120`,
      [organizationId],
    );
    return result.rows.map(mapMaintenance);
  }

  async createMaintenance(input: Record<string, unknown> & { organizationId: string }) {
    const result = await db.query(
      `INSERT INTO fleet.maintenance_records (
         organization_id, vehicle_id, service_date, odometer_km, service_type,
         description, provider, cost, currency, invoice_url, next_service_date,
         next_service_odometer_km, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'USD'),$10,$11,$12,$13)
       RETURNING *`,
      [
        input.organizationId,
        input.vehicleId,
        input.serviceDate,
        input.odometerKm ?? null,
        input.serviceType ?? 'service',
        input.notes ?? input.description ?? null,
        input.provider ?? null,
        input.cost ?? null,
        input.currency ?? 'USD',
        input.receiptUrl ?? input.invoiceUrl ?? null,
        input.nextServiceDate ?? null,
        input.nextServiceOdometerKm ?? null,
        input.createdBy ?? null,
      ],
    );
    return mapMaintenance(result.rows[0] as Record<string, unknown>);
  }

  async listSchedules(organizationId: string, requestedLimit?: number) {
    const limit = listLimit(requestedLimit);
    const result = await db.query(
      `SELECT s.*, v.vehicle_name, v.registration_number
       FROM fleet.service_schedules s
       LEFT JOIN fleet.vehicles v ON v.id = s.vehicle_id
       WHERE s.organization_id = $1
       ORDER BY s.next_service_date ASC NULLS LAST, s.id ASC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map(mapSchedule);
  }

  async listImportBatches(organizationId: string) {
    const batches = await db.query(
      `SELECT * FROM fleet.import_batches
       WHERE organization_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [organizationId],
    );
    const ids = batches.rows.map((row) => row.id);
    let rows: Record<string, unknown>[] = [];
    if (ids.length) {
      const rowsResult = await db.query(
        `SELECT * FROM fleet.import_rows
         WHERE batch_id = ANY($1::uuid[])
         ORDER BY created_at DESC LIMIT 120`,
        [ids],
      );
      rows = rowsResult.rows;
    }
    return { batches: batches.rows, rows };
  }

  async listOdometerReadings(organizationId: string, vehicleId: string, limit = 120) {
    const result = await db.query(
      `SELECT summary_date, odometer_km, route_length_km
       FROM fleet.daily_summaries
       WHERE organization_id = $1 AND vehicle_id = $2
       ORDER BY summary_date ASC
       LIMIT $3`,
      [organizationId, vehicleId, limit],
    );
    return result.rows.map((row) => ({
      summary_date: asDateOnly(row.summary_date),
      odometer_km: n(row.odometer_km),
      route_length_km: n(row.route_length_km) ?? 0,
    }));
  }
}
