import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import type { AuthContext } from '../authorization/types.js';
import { listOffset } from '../db/list-bounds.js';
import { ForbiddenError, ValidationError } from '../http/errors.js';
import { readListQuery } from '../http/list-query.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import { logger } from '../config/logger.js';
import type { PostgresMediaStore } from '../media/postgres-store.js';
import type { NotificationStore } from '../notifications/store.js';

export type MediaRouteDependencies = {
  store: PostgresMediaStore;
  notifications?: NotificationStore;
};

function formatHarareDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Harare',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function notifyShootApprovalNeeded(params: {
  notifications: NotificationStore;
  store: PostgresMediaStore;
  organizationId: string;
  bookingId: string;
  title: string;
  location: string;
  startsAt: string;
  transportLabel: string;
  actorUserId: string;
}) {
  const approverIds = await params.store.listShootApproverUserIds(
    params.organizationId,
    params.actorUserId,
  );
  const when = formatHarareDateTime(params.startsAt);
  await Promise.all(
    approverIds.map(async (recipientUserId) => {
      try {
        await params.notifications.create({
          organizationId: params.organizationId,
          recipientUserId,
          actorUserId: params.actorUserId,
          type: 'approval_needed',
          title: `Shoot approval needed: ${params.title}`,
          message: `A shoot at ${params.location} using ${params.transportLabel} has been requested for ${when} (Africa/Harare) and needs approval.`,
          entityType: 'approval',
          entityId: params.bookingId,
          actionUrl: '/shoot-bookings',
          priority: 'high',
          category: 'approvals',
          dedupeKey: `shoot_approval_needed:${params.bookingId}:${recipientUserId}`,
          metadata: {
            approvalId: params.bookingId,
            actorUserId: params.actorUserId,
          },
        });
      } catch (error) {
        logger.warn(
          { err: error, bookingId: params.bookingId, recipientUserId },
          'Failed to notify shoot approver',
        );
      }
    }),
  );
}

async function notifyShootApprovalDecision(params: {
  notifications: NotificationStore;
  organizationId: string;
  bookingId: string;
  title: string;
  location: string;
  startsAt: string;
  status: 'approved' | 'rejected';
  reviewNote?: string | null;
  requesterUserId: string;
  actorUserId: string;
}) {
  if (params.requesterUserId === params.actorUserId) return;
  const when = formatHarareDateTime(params.startsAt);
  const actorName =
    (await params.notifications.getDisplayName(params.actorUserId)) ?? null;
  const message =
    params.status === 'approved'
      ? `Your shoot at ${params.location} on ${when} (Africa/Harare) was approved. The vehicle is now reserved and the shoot is visible on the calendar.`
      : `Your shoot at ${params.location} on ${when} (Africa/Harare) was rejected.${
          params.reviewNote?.trim()
            ? ` Reason: ${params.reviewNote.trim()}`
            : ''
        }`;
  try {
    await params.notifications.create({
      organizationId: params.organizationId,
      recipientUserId: params.requesterUserId,
      actorUserId: params.actorUserId,
      type: 'approval_decision',
      title: `Shoot ${params.status}: ${params.title}`,
      message,
      entityType: 'approval',
      entityId: params.bookingId,
      actionUrl: '/shoot-bookings',
      priority: params.status === 'approved' ? 'medium' : 'high',
      category: 'approvals',
      dedupeKey: `shoot_approval_decision:${params.bookingId}:${params.status}`,
      metadata: {
        approvalId: params.bookingId,
        decision: params.status,
        actorUserId: params.actorUserId,
        actorName,
      },
    });
  } catch (error) {
    logger.warn(
      { err: error, bookingId: params.bookingId },
      'Failed to notify shoot requester',
    );
  }
}

const MEDIA_READ_ROLES = new Set([
  'admin',
  'manager',
  'it',
  'media_team',
  'social_media',
  'seo_specialist',
]);

const MEDIA_APPROVE_ROLES = new Set(['admin', 'manager']);

function authorizeMedia(auth: AuthContext, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: { type: 'media', organizationId },
  });
  return organizationId;
}

function canReadMedia(auth: AuthContext) {
  const roleKey = auth.membership.roleKey ?? '';
  return (
    MEDIA_READ_ROLES.has(roleKey) ||
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    hasPermission(auth.membership.permissions, 'media.read') ||
    hasPermission(auth.membership.permissions, 'media.manage')
  );
}

function canManageMedia(auth: AuthContext) {
  const roleKey = auth.membership.roleKey ?? '';
  return (
    MEDIA_READ_ROLES.has(roleKey) ||
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    hasPermission(auth.membership.permissions, 'media.manage')
  );
}

function canApproveShoot(auth: AuthContext) {
  const roleKey = auth.membership.roleKey ?? '';
  return (
    MEDIA_APPROVE_ROLES.has(roleKey) ||
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    hasPermission(auth.membership.permissions, 'media.approve')
  );
}

function requireMediaReader(auth: AuthContext) {
  if (!canReadMedia(auth)) {
    throw new ForbiddenError(
      'MEDIA_ACCESS_REQUIRED',
      'Media dashboard access is required.',
    );
  }
}

function requireMediaManager(auth: AuthContext) {
  if (!canManageMedia(auth)) {
    throw new ForbiddenError(
      'MEDIA_MANAGE_REQUIRED',
      'Media management access is required.',
    );
  }
}

export function createMediaRoutes(dependencies: MediaRouteDependencies) {
  const routes = new Hono();

  routes.get('/creative-requests', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.read');
    requireMediaReader(auth);
    const requests = await dependencies.store.listCreativeRequests(
      organizationId,
      readListQuery(c),
    );
    return c.json({
      requests: requests.requests.map((row) => ({
        ...row,
        requester: row.requester,
        assigned_to: row.assignee ?? null,
        attached_files: [],
      })),
      hasMore: requests.hasMore,
    });
  });

  routes.post('/creative-requests', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.manage');
    requireMediaManager(auth);
    const body = await readJson(c);
    const request = await dependencies.store.createCreativeRequest({
      organizationId,
      officeId:
        (body.officeId as string | undefined) ??
        (body.office_id as string | undefined) ??
        auth.membership.officeId ??
        null,
      requesterId: auth.actor.userId,
      title: readRequiredText(body.title, 'title', 300),
      description: readOptionalString(body.description, 'description', 5000),
      requestType: readRequiredText(
        body.requestType ?? body.request_type,
        'requestType',
        120,
      ),
      priority: readRequiredText(body.priority ?? 'medium', 'priority', 32),
      deadline:
        readOptionalString(body.deadline, 'deadline', 64) ?? null,
    });
    return c.json({ request }, 201);
  });

  routes.get('/deliveries', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.read');
    requireMediaReader(auth);
    const deliveries = await dependencies.store.listDeliveries(
      organizationId,
      readListQuery(c),
    );
    return c.json({ deliveries: deliveries.deliveries, hasMore: deliveries.hasMore });
  });

  routes.post('/deliveries', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.manage');
    requireMediaManager(auth);
    const body = await readJson(c);
    const delivery = await dependencies.store.createDelivery({
      organizationId,
      officeId:
        (body.officeId as string | undefined) ??
        (body.office_id as string | undefined) ??
        auth.membership.officeId ??
        null,
      createdBy: auth.actor.userId,
      title: readRequiredText(body.title, 'title', 300),
      deliveryType: readRequiredText(
        body.deliveryType ?? body.delivery_type,
        'deliveryType',
        120,
      ),
      deliverableFormat: readRequiredText(
        body.deliverableFormat ?? body.deliverable_format,
        'deliverableFormat',
        120,
      ),
      deliveredTo: readRequiredText(
        body.deliveredTo ?? body.delivered_to,
        'deliveredTo',
        300,
      ),
      deliveryDate:
        readOptionalString(
          body.deliveryDate ?? body.delivery_date,
          'deliveryDate',
          64,
        ) ?? null,
      fileUrl:
        readOptionalString(body.fileUrl ?? body.file_url, 'fileUrl', 2000) ??
        null,
    });
    return c.json({ delivery }, 201);
  });

  routes.get('/vehicles', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.read');
    requireMediaReader(auth);
    const page = readListQuery(c);
    const vehicles = await dependencies.store.listVehicles(organizationId, {
      limit: page.limit,
      offset: listOffset(Number(c.req.query('offset'))),
    });
    return c.json({ vehicles: vehicles.vehicles, hasMore: vehicles.hasMore });
  });

  routes.get('/shoot-bookings', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.read');
    requireMediaReader(auth);
    const statusRaw = (c.req.query('status') ?? '').trim().toLowerCase();
    const status =
      statusRaw &&
      ['pending', 'approved', 'rejected', 'cancelled'].includes(statusRaw)
        ? statusRaw
        : null;
    const bookings = await dependencies.store.listShootBookings(
      organizationId,
      { ...readListQuery(c), status },
    );
    return c.json({ bookings: bookings.bookings, hasMore: bookings.hasMore });
  });

  routes.post('/shoot-bookings', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.manage');
    requireMediaManager(auth);
    const body = await readJson(c);
    const startsAt = readRequiredText(
      body.startsAt ?? body.starts_at,
      'startsAt',
      64,
    );
    const endsAt = readRequiredText(body.endsAt ?? body.ends_at, 'endsAt', 64);
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      throw new ValidationError('End time must be after start time.', {
        field: 'endsAt',
      });
    }

    const vehicleOther = readOptionalString(
      body.vehicleOther ?? body.vehicle_other,
      'vehicleOther',
      200,
    );
    const vehicleIdRaw = body.vehicleId ?? body.vehicle_id;
    const isOther =
      vehicleIdRaw === '__other__' ||
      vehicleIdRaw === null ||
      vehicleIdRaw === undefined ||
      vehicleIdRaw === '';
    if (isOther && !vehicleOther) {
      throw new ValidationError(
        'Describe the other vehicle / transport option.',
        { field: 'vehicleOther' },
      );
    }

    const title = readRequiredText(body.title, 'title', 300);
    const location = readRequiredText(body.location, 'location', 500);
    const created = await dependencies.store.createShootBooking({
      organizationId,
      officeId:
        (body.officeId as string | undefined) ??
        (body.office_id as string | undefined) ??
        auth.membership.officeId ??
        null,
      vehicleId: isOther
        ? null
        : requireUuidValue(vehicleIdRaw, 'vehicleId'),
      vehicleOther: isOther ? vehicleOther : null,
      title,
      clientName: readOptionalString(
        body.clientName ?? body.client_name,
        'clientName',
        300,
      ),
      location,
      notes: readOptionalString(body.notes, 'notes', 5000),
      startsAt,
      endsAt,
      requestedBy: auth.actor.userId,
    });

    if (dependencies.notifications) {
      await notifyShootApprovalNeeded({
        notifications: dependencies.notifications,
        store: dependencies.store,
        organizationId,
        bookingId: created.id,
        title,
        location,
        startsAt,
        transportLabel: isOther
          ? `Other (${vehicleOther})`
          : 'a fleet vehicle',
        actorUserId: auth.actor.userId,
      });
    }

    return c.json({ id: created.id }, 201);
  });

  routes.patch('/shoot-bookings/:id/status', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeMedia(auth, 'media.approve');
    if (!canApproveShoot(auth)) {
      throw new ForbiddenError(
        'SHOOT_APPROVE_REQUIRED',
        'Only administrators and managers can approve shoot bookings.',
      );
    }
    const id = requireUuidValue(c.req.param('id'), 'id');
    const body = await readJson(c);
    const status = readRequiredText(body.status, 'status', 32);
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      throw new ValidationError('Invalid shoot booking status.', {
        field: 'status',
      });
    }
    const existing = await dependencies.store.getShootBooking(
      organizationId,
      id,
    );
    if (!existing) {
      throw new ValidationError('Shoot booking was not found.');
    }
    if (existing.status === status) {
      return c.json({ booking: existing });
    }

    const reviewNote = readOptionalString(
      body.reviewNote ?? body.review_note,
      'reviewNote',
      2000,
    );
    const booking = await dependencies.store.updateShootBookingStatus({
      organizationId,
      id,
      status,
      reviewNote,
      reviewerId: auth.actor.userId,
    });

    if (
      dependencies.notifications &&
      (status === 'approved' || status === 'rejected')
    ) {
      await notifyShootApprovalDecision({
        notifications: dependencies.notifications,
        organizationId,
        bookingId: booking.id,
        title: booking.title,
        location: booking.location,
        startsAt: booking.starts_at,
        status,
        reviewNote,
        requesterUserId: booking.requested_by,
        actorUserId: auth.actor.userId,
      });
    }

    return c.json({ booking });
  });

  return routes;
}
