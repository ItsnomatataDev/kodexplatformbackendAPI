import { keysetPredicate, listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { ConflictError, NotFoundError } from '../http/errors.js';

export type MediaProfileLite = {
  id: string;
  full_name: string | null;
  email: string | null;
  primary_role: string | null;
  department: string | null;
  avatar_url: string | null;
};

export type CreativeRequestRecord = {
  id: string;
  organization_id: string;
  office_id: string | null;
  title: string;
  description: string | null;
  request_type: string;
  priority: string;
  deadline: string | null;
  requester_id: string;
  assigned_to: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  requester?: MediaProfileLite | null;
  assignee?: MediaProfileLite | null;
};

export type DeliveryRecord = {
  id: string;
  organization_id: string;
  office_id: string | null;
  title: string;
  delivery_type: string;
  deliverable_format: string;
  delivered_to: string;
  delivery_date: string | null;
  file_url: string | null;
  file_object_key: string | null;
  status: string;
  approval_received: boolean;
  feedback_notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type FleetVehicleRecord = {
  id: string;
  organization_id: string;
  vehicle_name: string | null;
  registration_number: string | null;
  status: string;
};

export type ShootBookingRecord = {
  id: string;
  organization_id: string;
  office_id: string | null;
  vehicle_id: string | null;
  vehicle_other: string | null;
  title: string;
  client_name: string | null;
  location: string;
  notes: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  vehicle?: {
    vehicle_name: string | null;
    registration_number: string | null;
  } | null;
  requester?: { full_name: string | null; email: string | null } | null;
};

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.toISOString();
}

function isExclusionViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === '23P01',
  );
}

export class PostgresMediaStore {
  async listCreativeRequests(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'r.created_at',
      'r.id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `
        SELECT r.*,
          jsonb_build_object(
            'id', req.id,
            'full_name', reqp.full_name,
            'email', req.email,
            'primary_role', COALESCE(reqm.role_key, reqp.primary_role_key),
            'department', reqp.department,
            'avatar_url', reqp.avatar_url
          ) AS requester,
          CASE WHEN r.assigned_to IS NULL THEN NULL ELSE jsonb_build_object(
            'id', asg.id,
            'full_name', asgp.full_name,
            'email', asg.email,
            'primary_role', COALESCE(asgm.role_key, asgp.primary_role_key),
            'department', asgp.department,
            'avatar_url', asgp.avatar_url
          ) END AS assignee
        FROM media.creative_requests r
        JOIN identity.users req ON req.id = r.requester_id
        LEFT JOIN identity.user_profiles reqp ON reqp.user_id = req.id
        LEFT JOIN organizations.memberships reqm
          ON reqm.user_id = req.id AND reqm.organization_id = r.organization_id AND reqm.status = 'active'
        LEFT JOIN identity.users asg ON asg.id = r.assigned_to
        LEFT JOIN identity.user_profiles asgp ON asgp.user_id = asg.id
        LEFT JOIN organizations.memberships asgm
          ON asgm.user_id = asg.id AND asgm.organization_id = r.organization_id AND asgm.status = 'active'
        WHERE r.organization_id = $1
          ${cursor}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${params.length}
      `,
      params,
    );
    const mapped = result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      office_id: row.office_id,
      title: row.title,
      description: row.description,
      request_type: row.request_type,
      priority: row.priority,
      deadline: iso(row.deadline),
      requester_id: row.requester_id,
      assigned_to: row.assigned_to,
      status: row.status,
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
      requester: row.requester as MediaProfileLite,
      assignee: (row.assignee as MediaProfileLite | null) ?? null,
    }));
    const paged = pageOf(mapped, limit);
    return { requests: paged.rows, hasMore: paged.hasMore };
  }

  async createCreativeRequest(input: {
    organizationId: string;
    officeId?: string | null;
    requesterId: string;
    title: string;
    description?: string | null;
    requestType: string;
    priority: string;
    deadline?: string | null;
  }): Promise<CreativeRequestRecord> {
    const result = await db.query(
      `
        INSERT INTO media.creative_requests (
          organization_id, office_id, requester_id, title, description,
          request_type, priority, deadline
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
      `,
      [
        input.organizationId,
        input.officeId ?? null,
        input.requesterId,
        input.title,
        input.description ?? null,
        input.requestType,
        input.priority,
        input.deadline ?? null,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      organization_id: row.organization_id,
      office_id: row.office_id,
      title: row.title,
      description: row.description,
      request_type: row.request_type,
      priority: row.priority,
      deadline: iso(row.deadline),
      requester_id: row.requester_id,
      assigned_to: row.assigned_to,
      status: row.status,
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
    };
  }

  async listDeliveries(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `
        SELECT *
        FROM media.deliveries
        WHERE organization_id = $1
          ${cursor}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}
      `,
      params,
    );
    const mapped = result.rows.map((row) => ({
      ...row,
      delivery_date: iso(row.delivery_date),
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
    })) as DeliveryRecord[];
    const paged = pageOf(mapped, limit);
    return { deliveries: paged.rows, hasMore: paged.hasMore };
  }

  async createDelivery(input: {
    organizationId: string;
    officeId?: string | null;
    createdBy: string;
    title: string;
    deliveryType: string;
    deliverableFormat: string;
    deliveredTo: string;
    deliveryDate?: string | null;
    fileUrl?: string | null;
    fileObjectKey?: string | null;
  }): Promise<DeliveryRecord> {
    const result = await db.query(
      `
        INSERT INTO media.deliveries (
          organization_id, office_id, created_by, title, delivery_type,
          deliverable_format, delivered_to, delivery_date, file_url,
          file_object_key, status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `,
      [
        input.organizationId,
        input.officeId ?? null,
        input.createdBy,
        input.title,
        input.deliveryType,
        input.deliverableFormat,
        input.deliveredTo,
        input.deliveryDate ?? null,
        input.fileUrl ?? null,
        input.fileObjectKey ?? null,
        input.deliveryDate ? 'delivered' : 'preparing',
      ],
    );
    const row = result.rows[0];
    return {
      ...row,
      delivery_date: iso(row.delivery_date),
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
    } as DeliveryRecord;
  }

  async listVehicles(
    organizationId: string,
    page: { limit?: number; offset?: number } = {},
  ) {
    const limit = listLimit(page.limit);
    const result = await db.query(
      `
        SELECT id, organization_id, vehicle_name, registration_number, status
        FROM media.fleet_vehicles
        WHERE organization_id = $1
        ORDER BY vehicle_name NULLS LAST, id ASC
        LIMIT $2 OFFSET $3
      `,
      [organizationId, limit + 1, listOffset(page.offset)],
    );
    const paged = pageOf(result.rows as FleetVehicleRecord[], limit);
    return { vehicles: paged.rows, hasMore: paged.hasMore };
  }

  async listShootBookings(
    organizationId: string,
    page: {
      limit?: number;
      before?: string;
      beforeId?: string;
      status?: string | null;
    } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const statusFilter =
      page.status &&
      ['pending', 'approved', 'rejected', 'cancelled'].includes(page.status)
        ? page.status
        : null;
    let statusSql = '';
    if (statusFilter) {
      params.push(statusFilter);
      statusSql = `AND b.status = $${params.length}`;
    }
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'b.starts_at',
      'b.id',
      'desc',
    );
    params.push(limit + 1);
    const result = await db.query(
      `
        SELECT
          b.*,
          CASE WHEN b.vehicle_id IS NULL THEN NULL ELSE jsonb_build_object(
            'vehicle_name', v.vehicle_name,
            'registration_number', v.registration_number
          ) END AS vehicle,
          CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object(
            'full_name', p.full_name,
            'email', u.email
          ) END AS requester
        FROM media.shoot_bookings b
        LEFT JOIN media.fleet_vehicles v ON v.id = b.vehicle_id
        LEFT JOIN identity.users u ON u.id = b.requested_by
        LEFT JOIN identity.user_profiles p ON p.user_id = u.id
        WHERE b.organization_id = $1
          ${statusSql}
          ${cursor}
        ORDER BY
          CASE WHEN b.status = 'pending' THEN 0 ELSE 1 END ASC,
          b.starts_at DESC,
          b.id DESC
        LIMIT $${params.length}
      `,
      params,
    );
    const mapped = result.rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      office_id: row.office_id,
      vehicle_id: row.vehicle_id,
      vehicle_other: row.vehicle_other,
      title: row.title,
      client_name: row.client_name,
      location: row.location,
      notes: row.notes,
      starts_at: iso(row.starts_at)!,
      ends_at: iso(row.ends_at)!,
      status: row.status,
      requested_by: row.requested_by,
      reviewed_by: row.reviewed_by,
      reviewed_at: iso(row.reviewed_at),
      review_note: row.review_note,
      created_at: iso(row.created_at)!,
      vehicle: row.vehicle,
      requester: row.requester,
    }));
    const paged = pageOf(mapped, limit);
    return { bookings: paged.rows, hasMore: paged.hasMore };
  }

  async createShootBooking(input: {
    organizationId: string;
    officeId?: string | null;
    vehicleId?: string | null;
    vehicleOther?: string | null;
    title: string;
    clientName?: string | null;
    location: string;
    notes?: string | null;
    startsAt: string;
    endsAt: string;
    requestedBy: string;
  }): Promise<{ id: string }> {
    try {
      const result = await db.query(
        `
          INSERT INTO media.shoot_bookings (
            organization_id, office_id, vehicle_id, vehicle_other, title,
            client_name, location, notes, starts_at, ends_at, requested_by, status
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
          RETURNING id
        `,
        [
          input.organizationId,
          input.officeId ?? null,
          input.vehicleId ?? null,
          input.vehicleOther ?? null,
          input.title,
          input.clientName ?? null,
          input.location,
          input.notes ?? null,
          input.startsAt,
          input.endsAt,
          input.requestedBy,
        ],
      );
      return { id: result.rows[0].id as string };
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw new ConflictError(
          'VEHICLE_CONFLICT',
          'That vehicle is already requested or booked during this time.',
        );
      }
      throw error;
    }
  }

  async updateShootBookingStatus(input: {
    organizationId: string;
    id: string;
    status: string;
    reviewNote?: string | null;
    reviewerId?: string | null;
  }): Promise<ShootBookingRecord> {
    try {
      const result = await db.query(
        `
          UPDATE media.shoot_bookings
          SET
            status = $3,
            review_note = $4,
            reviewed_by = $5,
            reviewed_at = NOW(),
            updated_at = NOW()
          WHERE organization_id = $1 AND id = $2
          RETURNING *
        `,
        [
          input.organizationId,
          input.id,
          input.status,
          input.reviewNote ?? null,
          input.reviewerId ?? null,
        ],
      );
      if (!result.rows[0]) {
        throw new NotFoundError(
          'SHOOT_BOOKING_NOT_FOUND',
          'Shoot booking was not found.',
        );
      }
      const row = result.rows[0];
      return {
        id: row.id,
        organization_id: row.organization_id,
        office_id: row.office_id,
        vehicle_id: row.vehicle_id,
        vehicle_other: row.vehicle_other,
        title: row.title,
        client_name: row.client_name,
        location: row.location,
        notes: row.notes,
        starts_at: iso(row.starts_at)!,
        ends_at: iso(row.ends_at)!,
        status: row.status,
        requested_by: row.requested_by,
        reviewed_by: row.reviewed_by,
        reviewed_at: iso(row.reviewed_at),
        review_note: row.review_note,
        created_at: iso(row.created_at)!,
      };
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw new ConflictError(
          'VEHICLE_CONFLICT',
          'This vehicle has another booking during that time.',
        );
      }
      throw error;
    }
  }

  async getShootBooking(
    organizationId: string,
    id: string,
  ): Promise<ShootBookingRecord | null> {
    const result = await db.query(
      `SELECT * FROM media.shoot_bookings WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organization_id: row.organization_id,
      office_id: row.office_id,
      vehicle_id: row.vehicle_id,
      vehicle_other: row.vehicle_other,
      title: row.title,
      client_name: row.client_name,
      location: row.location,
      notes: row.notes,
      starts_at: iso(row.starts_at)!,
      ends_at: iso(row.ends_at)!,
      status: row.status,
      requested_by: row.requested_by,
      reviewed_by: row.reviewed_by,
      reviewed_at: iso(row.reviewed_at),
      review_note: row.review_note,
      created_at: iso(row.created_at)!,
    };
  }

  async listShootApproverUserIds(
    organizationId: string,
    excludeUserId?: string | null,
  ): Promise<string[]> {
    const result = await db.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
       FROM organizations.memberships m
       LEFT JOIN organizations.roles r ON r.id = m.role_id
       WHERE m.organization_id = $1
         AND m.status = 'active'
         AND (
           m.role_key = ANY($2::text[])
           OR COALESCE(r.is_admin_role, FALSE)
           OR COALESCE(r.is_manager_role, FALSE)
         )
         AND ($3::uuid IS NULL OR m.user_id <> $3)`,
      [
        organizationId,
        ['admin', 'org_admin', 'manager'],
        excludeUserId ?? null,
      ],
    );
    return result.rows.map((row) => row.user_id);
  }
}
