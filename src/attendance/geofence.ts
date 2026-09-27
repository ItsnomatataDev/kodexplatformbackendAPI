/**
 * Server-side attendance geofence helpers (haversine).
 * Mirrors the frontend multi-site fence shape under office.settings.
 */

export type OfficeGeofence = {
  enabled: boolean;
  label: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  maxAccuracyMeters: number;
};

const EARTH_RADIUS_M = 6_371_000;
const DEFAULT_MAX_ACCURACY_M = 300;

/**
 * Location checks stay off until each site has confirmed coordinates.
 * Stored office pins are left in place; clock-in does not read them.
 */
export const ATTENDANCE_GEOFENCE_ENFORCED = false;

function parseOneFence(raw: unknown): OfficeGeofence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fence = raw as Record<string, unknown>;
  const latitude = Number(fence.latitude ?? fence.lat);
  const longitude = Number(fence.longitude ?? fence.lng);
  const radius = Number(fence.radius_meters ?? fence.radiusMeters ?? 150);
  const maxAccuracy = Number(
    fence.max_accuracy_meters ?? fence.maxAccuracyMeters ?? DEFAULT_MAX_ACCURACY_M,
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (!Number.isFinite(radius) || radius <= 0) return null;
  return {
    enabled: fence.enabled !== false,
    label: typeof fence.label === 'string' ? fence.label : null,
    latitude,
    longitude,
    radiusMeters: radius,
    maxAccuracyMeters:
      Number.isFinite(maxAccuracy) && maxAccuracy > 0
        ? maxAccuracy
        : DEFAULT_MAX_ACCURACY_M,
  };
}

export function parseOfficeGeofences(
  settings?: Record<string, unknown> | null,
): OfficeGeofence[] {
  if (!settings || typeof settings !== 'object') return [];

  const many = Array.isArray(settings.geofences)
    ? settings.geofences
        .map(parseOneFence)
        .filter((fence): fence is OfficeGeofence => Boolean(fence?.enabled))
    : [];
  if (many.length > 0) return many;

  const single = parseOneFence(settings.geofence);
  return single?.enabled ? [single] : [];
}

function distanceMetersBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const φ1 = (a.latitude * Math.PI) / 180;
  const φ2 = (b.latitude * Math.PI) / 180;
  const Δφ = ((b.latitude - a.latitude) * Math.PI) / 180;
  const Δλ = ((b.longitude - a.longitude) * Math.PI) / 180;
  const sinΔφ = Math.sin(Δφ / 2);
  const sinΔλ = Math.sin(Δλ / 2);
  const h =
    sinΔφ * sinΔφ + Math.cos(φ1) * Math.cos(φ2) * sinΔλ * sinΔλ;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function assertWithinOfficeGeofences(params: {
  settings: Record<string, unknown> | null | undefined;
  location: Record<string, unknown> | null | undefined;
}) {
  if (!ATTENDANCE_GEOFENCE_ENFORCED) return;

  const fences = parseOfficeGeofences(params.settings ?? null);
  if (fences.length === 0) return;

  const latitude = Number(
    params.location?.latitude ?? params.location?.lat,
  );
  const longitude = Number(
    params.location?.longitude ?? params.location?.lng,
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(
      'Location is required to clock in at this office. Enable GPS and try again.',
    );
  }

  let nearestDistance = Number.POSITIVE_INFINITY;
  const accuracy = Number(params.location?.accuracy ?? params.location?.accuracyMeters);
  const gpsAccuracy =
    Number.isFinite(accuracy) && accuracy > 0 ? Math.max(0, accuracy) : 0;

  for (const fence of fences) {
    const distance = distanceMetersBetween(
      { latitude, longitude },
      { latitude: fence.latitude, longitude: fence.longitude },
    );
    
    const effectiveRadius = fence.radiusMeters + Math.min(gpsAccuracy, 100);
    if (distance <= effectiveRadius) {
      return;
    }
    if (distance < nearestDistance) {
      nearestDistance = distance;
    }
  }


  throw new Error(
    'Clock-in blocked: your current location is unknown. Move to your office site and try again.',
  );
}
