import { listLimit } from '../db/list-bounds.js';
import { db } from '../db/pool.js';

function iso(row: Record<string, unknown>, keys: string[]) {
  const out = { ...row };
  for (const key of keys) {
    const v = out[key];
    if (v instanceof Date) out[key] = v.toISOString();
    else if (v != null && key.endsWith('_date')) out[key] = String(v).slice(0, 10);
    else if (v != null && key.endsWith('_time') && !key.includes('at')) out[key] = String(v).slice(0, 8);
  }
  return out;
}

export class PostgresTourismStore {
  async dashboard(organizationId: string, requestedLimit?: number) {
    const limit = listLimit(requestedLimit);
    const [guests, bookings, itineraries, transfers] = await Promise.all([
      db.query(
        `SELECT * FROM tourism.guests WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [organizationId, limit],
      ),
      db.query(
        `SELECT b.*, g.full_name AS guest_full_name, g.phone AS guest_phone, g.email AS guest_email
         FROM tourism.bookings b
         LEFT JOIN tourism.guests g ON g.id = b.guest_id
         WHERE b.organization_id = $1
         ORDER BY b.booking_date DESC, b.id DESC
         LIMIT $2`,
        [organizationId, limit],
      ),
      db.query(
        `SELECT i.*, g.full_name AS guest_full_name
         FROM tourism.itinerary_items i
         LEFT JOIN tourism.guests g ON g.id = i.guest_id
         WHERE i.organization_id = $1
         ORDER BY i.starts_at DESC, i.id DESC
         LIMIT $2`,
        [organizationId, limit],
      ),
      db.query(
        `SELECT t.*, g.full_name AS guest_full_name, g.phone AS guest_phone
         FROM tourism.transfers t
         LEFT JOIN tourism.guests g ON g.id = t.guest_id
         WHERE t.organization_id = $1
         ORDER BY t.scheduled_at DESC, t.id DESC
         LIMIT $2`,
        [organizationId, limit],
      ),
    ]);
    return {
      guests: guests.rows.map((r) => iso(r, ['created_at', 'updated_at'])),
      bookings: bookings.rows.map((r) => ({
        ...iso(r, ['booking_date', 'pickup_time', 'created_at', 'updated_at']),
        guest: r.guest_id
          ? { id: r.guest_id, full_name: r.guest_full_name, phone: r.guest_phone, email: r.guest_email }
          : null,
      })),
      itineraries: itineraries.rows.map((r) => ({
        ...iso(r, ['starts_at', 'ends_at', 'created_at', 'updated_at']),
        guest: r.guest_id ? { id: r.guest_id, full_name: r.guest_full_name } : null,
      })),
      transfers: transfers.rows.map((r) => ({
        ...iso(r, ['scheduled_at', 'created_at', 'updated_at']),
        guest: r.guest_id
          ? { id: r.guest_id, full_name: r.guest_full_name, phone: r.guest_phone }
          : null,
      })),
    };
  }

  async createGuest(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO tourism.guests (
         organization_id, full_name, email, phone, nationality, guest_count,
         preferences, special_requests, status, created_by
       ) VALUES ($1,$2,$3,$4,$5,COALESCE($6,1),$7,$8,COALESCE($9,'active'),$10)
       RETURNING *`,
      [
        organizationId,
        input.fullName ?? input.full_name,
        input.email ?? null,
        input.phone ?? null,
        input.nationality ?? null,
        input.guestCount ?? input.guest_count ?? 1,
        input.preferences ?? null,
        input.specialRequests ?? input.special_requests ?? null,
        input.status ?? 'active',
        createdBy,
      ],
    );
    return iso(result.rows[0], ['created_at', 'updated_at']);
  }

  async createBooking(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO tourism.bookings (
         organization_id, guest_id, booking_reference, activity_name, booking_date,
         pickup_time, pickup_location, guest_count, status, payment_status, notes,
         assigned_guide_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,1),COALESCE($9,'pending'),COALESCE($10,'unpaid'),$11,$12,$13)
       RETURNING *`,
      [
        organizationId,
        input.guestId ?? input.guest_id ?? null,
        input.bookingReference ?? input.booking_reference ?? null,
        input.activityName ?? input.activity_name,
        input.bookingDate ?? input.booking_date,
        input.pickupTime ?? input.pickup_time ?? null,
        input.pickupLocation ?? input.pickup_location ?? null,
        input.guestCount ?? input.guest_count ?? 1,
        input.status ?? 'pending',
        input.paymentStatus ?? input.payment_status ?? 'unpaid',
        input.notes ?? null,
        input.assignedGuideId ?? input.assigned_guide_id ?? null,
        createdBy,
      ],
    );
    return iso(result.rows[0], ['booking_date', 'pickup_time', 'created_at', 'updated_at']);
  }

  async createItinerary(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO tourism.itinerary_items (
         organization_id, booking_id, guest_id, title, item_type, starts_at, ends_at,
         location, status, notes, assigned_user_id, created_by
       ) VALUES ($1,$2,$3,$4,COALESCE($5,'activity'),$6,$7,$8,COALESCE($9,'planned'),$10,$11,$12)
       RETURNING *`,
      [
        organizationId,
        input.bookingId ?? input.booking_id ?? null,
        input.guestId ?? input.guest_id ?? null,
        input.title,
        input.itemType ?? input.item_type ?? 'activity',
        input.startsAt ?? input.starts_at,
        input.endsAt ?? input.ends_at ?? null,
        input.location ?? null,
        input.status ?? 'planned',
        input.notes ?? null,
        input.assignedUserId ?? input.assigned_user_id ?? null,
        createdBy,
      ],
    );
    return iso(result.rows[0], ['starts_at', 'ends_at', 'created_at', 'updated_at']);
  }

  async createTransfer(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO tourism.transfers (
         organization_id, booking_id, guest_id, transfer_type, pickup_location, dropoff_location,
         scheduled_at, status, driver_id, vehicle_id, notes, created_by
       ) VALUES ($1,$2,$3,COALESCE($4,'pickup'),$5,$6,$7,COALESCE($8,'scheduled'),$9,$10,$11,$12)
       RETURNING *`,
      [
        organizationId,
        input.bookingId ?? input.booking_id ?? null,
        input.guestId ?? input.guest_id ?? null,
        input.transferType ?? input.transfer_type ?? 'pickup',
        input.pickupLocation ?? input.pickup_location,
        input.dropoffLocation ?? input.dropoff_location,
        input.scheduledAt ?? input.scheduled_at,
        input.status ?? 'scheduled',
        input.driverId ?? input.driver_id ?? null,
        input.vehicleId ?? input.vehicle_id ?? null,
        input.notes ?? null,
        createdBy,
      ],
    );
    return iso(result.rows[0], ['scheduled_at', 'created_at', 'updated_at']);
  }
}
