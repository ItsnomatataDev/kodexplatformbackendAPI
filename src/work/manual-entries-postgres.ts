import { db } from '../db/pool.js';
import type { ManualEntrySettings, VehicleShootMatch } from './store.js';

type SettingsRow = { time_tracking: Record<string, unknown> | null };

export async function getManualEntrySettingsFromDb(organizationId: string): Promise<ManualEntrySettings> {
  const result = await db.query<SettingsRow>(
    `SELECT settings -> 'timeTracking' AS time_tracking
       FROM organizations.organizations
      WHERE id = $1`,
    [organizationId],
  );
  return readManualEntrySettings(result.rows[0]?.time_tracking ?? null);
}

export async function updateManualEntrySettingsInDb(
  organizationId: string,
  manualEntriesEnabled: boolean,
  actorUserId: string,
): Promise<ManualEntrySettings> {
  const result = await db.query<SettingsRow>(
    `UPDATE organizations.organizations
        SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{timeTracking}',
              COALESCE(settings -> 'timeTracking', '{}'::jsonb) || jsonb_build_object(
                'manualEntriesEnabled', $2::boolean,
                'updatedAt', to_jsonb(NOW()),
                'updatedBy', $3::text
              ),
              TRUE
            )
      WHERE id = $1
      RETURNING settings -> 'timeTracking' AS time_tracking`,
    [organizationId, manualEntriesEnabled, actorUserId],
  );
  return readManualEntrySettings(result.rows[0]?.time_tracking ?? null);
}

export async function findVehicleShootForDayInDb(
  organizationId: string,
  userId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<VehicleShootMatch | null> {
  const result = await db.query<{
    id: string;
    title: string;
    location: string | null;
    status: string;
    starts_at: Date;
    ends_at: Date;
    vehicle_label: string | null;
  }>(
    `SELECT booking.id, booking.title, booking.location, booking.status,
            booking.starts_at, booking.ends_at,
            COALESCE(
              NULLIF(btrim(concat_ws(' ', vehicle.vehicle_name,
                NULLIF(vehicle.registration_number, vehicle.vehicle_name))), ''),
              NULLIF(btrim(booking.vehicle_other), '')
            ) AS vehicle_label
       FROM media.shoot_bookings booking
       LEFT JOIN media.fleet_vehicles vehicle
         ON vehicle.id = booking.vehicle_id
      WHERE booking.organization_id = $1
        AND booking.requested_by = $2
        AND booking.status IN ('pending', 'approved')
        AND (booking.vehicle_id IS NOT NULL OR NULLIF(btrim(booking.vehicle_other), '') IS NOT NULL)
        AND booking.starts_at < $4
        AND booking.ends_at > $3
      ORDER BY (booking.status = 'approved') DESC, booking.starts_at ASC
      LIMIT 1`,
    [organizationId, userId, dayStart, dayEnd],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    location: row.location,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    vehicleLabel: row.vehicle_label,
  };
}

function readManualEntrySettings(value: Record<string, unknown> | null): ManualEntrySettings {
  const updatedAt = typeof value?.updatedAt === 'string' ? new Date(value.updatedAt) : null;
  return {
    manualEntriesEnabled: value?.manualEntriesEnabled !== false,
    updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
    updatedBy: typeof value?.updatedBy === 'string' ? value.updatedBy : null,
  };
}

export const postgresManualEntryPolicySource = {
  getManualEntrySettings: getManualEntrySettingsFromDb,
  findVehicleShootForDay: findVehicleShootForDayInDb,
};
