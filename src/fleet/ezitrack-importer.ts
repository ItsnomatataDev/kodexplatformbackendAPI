import { db } from '../db/pool.js';
import { ValidationError } from '../http/errors.js';

type EziTrackRecord = Record<string, unknown>;

export type EziTrackImportInput = {
  source?: string;
  fileName?: string | null;
  emailSubject?: string | null;
  emailFrom?: string | null;
  receivedAt?: string | null;
  messageId?: string | null;
  records: EziTrackRecord[];
};

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function seconds(value: unknown): number | null {
  const direct = number(value);
  if (direct !== null) return direct;

  const raw = text(value);
  if (!raw) return null;

  const parts = raw.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;

  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }

  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }

  return null;
}

function pick(record: EziTrackRecord, ...keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return null;
}

function iso(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateOnly(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;

  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1]!;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.toISOString().slice(0, 10);
}

function normalizeVehicle(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function mappedRecord(record: EziTrackRecord) {
  const object = text(
    pick(record, 'object', 'Object', 'vehicle', 'vehicleName', 'vehicle_name'),
  );

  const periodStart = iso(
    pick(record, 'periodStart', 'period_start', 'Period start'),
  );

  const periodEnd = iso(
    pick(record, 'periodEnd', 'period_end', 'Period end'),
  );

  return {
    object,
    periodStart,
    periodEnd,

    routeLengthKm: number(
      pick(record, 'routeLengthKm', 'route_length_km', 'Route length'),
    ),

    moveDurationSeconds: seconds(
      pick(
        record,
        'moveDurationSeconds',
        'move_duration_seconds',
        'moveDuration',
        'Move duration',
      ),
    ),

    stopDurationSeconds: seconds(
      pick(
        record,
        'stopDurationSeconds',
        'stop_duration_seconds',
        'stopDuration',
        'Stop duration',
      ),
    ),

    stopCount: number(pick(record, 'stopCount', 'stop_count', 'Stop count')),

    topSpeedKph: number(
      pick(record, 'topSpeedKph', 'top_speed_kph', 'topSpeed', 'Top speed'),
    ),

    averageSpeedKph: number(
      pick(
        record,
        'averageSpeedKph',
        'average_speed_kph',
        'averageSpeed',
        'Average speed',
      ),
    ),

    overspeedCount: number(
      pick(record, 'overspeedCount', 'overspeed_count', 'Overspeed count'),
    ),

    fuelConsumptionLitres: number(
      pick(
        record,
        'fuelConsumptionLitres',
        'fuel_consumption_litres',
        'fuelConsumption',
        'Fuel consumption',
      ),
    ),

    averageFuelConsumptionPer100Km: number(
      pick(
        record,
        'averageFuelConsumptionPer100Km',
        'average_fuel_consumption_per_100km',
        'averageFuelConsumption',
        'Avg fuel cons 100km',
      ),
    ),

    fuelCost: number(pick(record, 'fuelCost', 'fuel_cost', 'Fuel cost')),

    fuelCurrency: text(
      pick(record, 'fuelCurrency', 'fuel_currency', 'currency'),
    ),

    engineWorkSeconds: seconds(
      pick(
        record,
        'engineWorkSeconds',
        'engine_work_seconds',
        'engineWork',
        'Engine work',
      ),
    ),

    engineIdleSeconds: seconds(
      pick(
        record,
        'engineIdleSeconds',
        'engine_idle_seconds',
        'engineIdle',
        'Engine idle',
      ),
    ),

    odometerKm: number(
      pick(record, 'odometerKm', 'odometer_km', 'odometer', 'Odometer'),
    ),

    engineHours: seconds(
      pick(
        record,
        'engineHoursSeconds',
        'engine_hours_seconds',
        'engineHours',
        'engine_hours',
        'Engine hours',
      ),
    ),

    driverName: text(
      pick(record, 'driverName', 'driver_name', 'driver', 'Driver'),
    ),
  };
}

export async function importEziTrackDailyReport(
  organizationId: string,
  input: EziTrackImportInput,
) {
  if (!Array.isArray(input.records) || input.records.length === 0) {
    throw new ValidationError('records must contain at least one EziTrack record.');
  }

  if (input.records.length > 500) {
    throw new ValidationError('EziTrack import cannot contain more than 500 records.');
  }

  const source = text(input.source) ?? 'ezitrack_email';
  const fileName = text(input.fileName) ?? 'ezitrack-daily-report-email';
  const messageId = text(input.messageId);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    /*
     * n8n may retry a request if the connection drops after Kode committed it.
     * messageId therefore acts as whole-email idempotency when available.
     */
    if (messageId) {
      const duplicate = await client.query(
        `SELECT id, status, total_rows, imported_rows, failed_rows
           FROM fleet.import_batches
          WHERE organization_id = $1
            AND source = $2
            AND metadata->>'message_id' = $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [organizationId, source, messageId],
      );

      if (duplicate.rows[0]) {
        await client.query('ROLLBACK');

        return {
          duplicate: true,
          batch: duplicate.rows[0],
        };
      }
    }

    const batchResult = await client.query(
      `INSERT INTO fleet.import_batches (
         organization_id,
         source,
         import_type,
         file_name,
         status,
         total_rows,
         imported_rows,
         failed_rows,
         metadata
       )
       VALUES ($1, $2, 'daily_report', $3, 'processing', $4, 0, 0, $5::jsonb)
       RETURNING id`,
      [
        organizationId,
        source,
        fileName,
        input.records.length,
        JSON.stringify({
          email_subject: text(input.emailSubject),
          email_from: text(input.emailFrom),
          received_at: iso(input.receivedAt),
          message_id: messageId,
          unmatched_vehicles: [],
        }),
      ],
    );

    const batchId = String(batchResult.rows[0].id);

    const vehicleResult = await client.query(
      `SELECT
         id,
         vehicle_name,
         registration_number,
         ezitrack_import_paused
       FROM fleet.vehicles
       WHERE organization_id = $1
         AND status <> 'retired'`,
      [organizationId],
    );

    const vehicles = vehicleResult.rows as Array<{
      id: string;
      vehicle_name: string;
      registration_number: string | null;
      ezitrack_import_paused: boolean;
    }>;

    let importedRows = 0;
    let failedRows = 0;
    let unmatchedRows = 0;
    let skippedMaintenanceRows = 0;

    const unmatchedVehicles = new Set<string>();

    for (let index = 0; index < input.records.length; index += 1) {
      const raw = input.records[index]!;
      const mapped = mappedRecord(raw);
      const objectKey = normalizeVehicle(mapped.object);

      const vehicle =
        vehicles.find(
          (candidate) =>
            normalizeVehicle(candidate.registration_number) === objectKey &&
            objectKey.length > 0,
        ) ??
        vehicles.find(
          (candidate) =>
            normalizeVehicle(candidate.vehicle_name) === objectKey &&
            objectKey.length > 0,
        ) ??
        null;

      if (!vehicle) {
        unmatchedRows += 1;
        failedRows += 1;

        if (mapped.object) unmatchedVehicles.add(mapped.object);

        await client.query(
          `INSERT INTO fleet.import_rows (
             organization_id,
             batch_id,
             row_number,
             raw_data,
             mapped_data,
             vehicle_id,
             status,
             error_message
           )
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NULL, 'unmatched', $6)`,
          [
            organizationId,
            batchId,
            index + 1,
            JSON.stringify(raw),
            JSON.stringify(mapped),
            mapped.object
              ? `No Fleet vehicle matched EziTrack object "${mapped.object}".`
              : 'EziTrack record has no vehicle/object value.',
          ],
        );

        continue;
      }

      if (vehicle.ezitrack_import_paused) {
        skippedMaintenanceRows += 1;

        await client.query(
          `INSERT INTO fleet.import_rows (
             organization_id,
             batch_id,
             row_number,
             raw_data,
             mapped_data,
             vehicle_id,
             status,
             error_message
           )
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, 'skipped_maintenance', NULL)`,
          [
            organizationId,
            batchId,
            index + 1,
            JSON.stringify(raw),
            JSON.stringify(mapped),
            vehicle.id,
          ],
        );

        continue;
      }

      /*
       * EziTrack reports are daily local-time reports. Do not derive the
       * reporting day from the UTC-normalized period timestamp because
       * local midnight can become the previous UTC calendar date.
       *
       * Prefer the original periodStart value from n8n, whose leading
       * YYYY-MM-DD is the EziTrack reporting day.
       */
      const summaryDate =
        dateOnly(
          pick(
            raw,
            'periodStart',
            'period_start',
            'Period start',
          ),
        ) ??
        dateOnly(
          pick(
            raw,
            'routeStart',
            'route_start',
            'Route start',
          ),
        ) ??
        dateOnly(input.receivedAt);

      if (!summaryDate) {
        failedRows += 1;

        await client.query(
          `INSERT INTO fleet.import_rows (
             organization_id,
             batch_id,
             row_number,
             raw_data,
             mapped_data,
             vehicle_id,
             status,
             error_message
           )
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, 'failed', $7)`,
          [
            organizationId,
            batchId,
            index + 1,
            JSON.stringify(raw),
            JSON.stringify(mapped),
            vehicle.id,
            'Unable to determine summary date.',
          ],
        );

        continue;
      }

      await client.query(
        `INSERT INTO fleet.daily_summaries (
           organization_id,
           vehicle_id,
           summary_date,
           source,
           period_start,
           period_end,
           route_length_km,
           move_duration_seconds,
           stop_duration_seconds,
           stop_count,
           top_speed_kph,
           average_speed_kph,
           overspeed_count,
           fuel_consumption_litres,
           average_fuel_consumption_per_100km,
           fuel_cost,
           fuel_currency,
           engine_work_seconds,
           engine_idle_seconds,
           odometer_km,
           engine_hours,
           driver_name,
           raw_data,
           imported_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19,
           $20, $21, $22, $23::jsonb, NOW()
         )
         ON CONFLICT (vehicle_id, summary_date, source)
         DO UPDATE SET
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end,
           route_length_km = EXCLUDED.route_length_km,
           move_duration_seconds = EXCLUDED.move_duration_seconds,
           stop_duration_seconds = EXCLUDED.stop_duration_seconds,
           stop_count = EXCLUDED.stop_count,
           top_speed_kph = EXCLUDED.top_speed_kph,
           average_speed_kph = EXCLUDED.average_speed_kph,
           overspeed_count = EXCLUDED.overspeed_count,
           fuel_consumption_litres = EXCLUDED.fuel_consumption_litres,
           average_fuel_consumption_per_100km =
             EXCLUDED.average_fuel_consumption_per_100km,
           fuel_cost = EXCLUDED.fuel_cost,
           fuel_currency = EXCLUDED.fuel_currency,
           engine_work_seconds = EXCLUDED.engine_work_seconds,
           engine_idle_seconds = EXCLUDED.engine_idle_seconds,
           odometer_km = EXCLUDED.odometer_km,
           engine_hours = EXCLUDED.engine_hours,
           driver_name = EXCLUDED.driver_name,
           raw_data = EXCLUDED.raw_data,
           imported_at = NOW()`,
        [
          organizationId,
          vehicle.id,
          summaryDate,
          source,
          mapped.periodStart,
          mapped.periodEnd,
          mapped.routeLengthKm,
          mapped.moveDurationSeconds,
          mapped.stopDurationSeconds,
          mapped.stopCount,
          mapped.topSpeedKph,
          mapped.averageSpeedKph,
          mapped.overspeedCount,
          mapped.fuelConsumptionLitres,
          mapped.averageFuelConsumptionPer100Km,
          mapped.fuelCost,
          mapped.fuelCurrency,
          mapped.engineWorkSeconds,
          mapped.engineIdleSeconds,
          mapped.odometerKm,
          mapped.engineHours,
          mapped.driverName,
          JSON.stringify(raw),
        ],
      );

      if (mapped.odometerKm !== null) {
        await client.query(
          `UPDATE fleet.vehicles
              SET current_odometer_km =
                    CASE
                      WHEN current_odometer_km IS NULL
                        OR $3 >= current_odometer_km
                      THEN $3
                      ELSE current_odometer_km
                    END,
                  latest_odometer_at =
                    CASE
                      WHEN current_odometer_km IS NULL
                        OR $3 >= current_odometer_km
                      THEN COALESCE($4::timestamptz, NOW())
                      ELSE latest_odometer_at
                    END,
                  updated_at = NOW()
            WHERE organization_id = $1
              AND id = $2`,
          [
            organizationId,
            vehicle.id,
            mapped.odometerKm,
            mapped.periodEnd ?? mapped.periodStart,
          ],
        );
      }

      await client.query(
        `INSERT INTO fleet.import_rows (
           organization_id,
           batch_id,
           row_number,
           raw_data,
           mapped_data,
           vehicle_id,
           status,
           error_message
         )
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, 'imported', NULL)`,
        [
          organizationId,
          batchId,
          index + 1,
          JSON.stringify(raw),
          JSON.stringify(mapped),
          vehicle.id,
        ],
      );

      importedRows += 1;
    }

    const status =
      failedRows === 0
        ? 'completed'
        : importedRows > 0 || skippedMaintenanceRows > 0
          ? 'partial_failed'
          : 'failed';

    const completed = await client.query(
      `UPDATE fleet.import_batches
          SET status = $3,
              imported_rows = $4,
              failed_rows = $5,
              metadata =
                COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object(
                  'unmatched_vehicles', $6::jsonb,
                  'unmatched_rows', $7,
                  'skipped_maintenance_rows', $8
                ),
              completed_at = NOW()
        WHERE organization_id = $1
          AND id = $2
        RETURNING
          id,
          source,
          import_type,
          file_name,
          status,
          total_rows,
          imported_rows,
          failed_rows,
          created_at,
          completed_at,
          metadata`,
      [
        organizationId,
        batchId,
        status,
        importedRows,
        failedRows,
        JSON.stringify([...unmatchedVehicles]),
        unmatchedRows,
        skippedMaintenanceRows,
      ],
    );

    await client.query('COMMIT');

    return {
      duplicate: false,
      batch: completed.rows[0],
      importedRows,
      failedRows,
      unmatchedRows,
      skippedMaintenanceRows,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
