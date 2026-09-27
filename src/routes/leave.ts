import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { assertAuthorized } from '../authorization/authorize.js';
import { hasPermission } from '../authorization/permissions.js';
import { requireOrganizationId } from '../authorization/organization.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import type { AuthContext } from '../authorization/types.js';
import {
  calculateLeaveDaysForOffice,
  type PostgresLeaveStore,
} from '../leave/postgres-store.js';
import { readListQuery } from '../http/list-query.js';

export type LeaveRouteDependencies = {
  store: PostgresLeaveStore;
};

function authorizeLeave(auth: ReturnType<typeof getAuth>, action: string) {
  const organizationId = requireOrganizationId(auth);
  assertAuthorized({
    context: auth,
    action,
    resource: { type: 'leave', organizationId },
  });
  return organizationId;
}

function isLeaveStaff(auth: AuthContext) {
  return (
    auth.membership.isAdminRole ||
    auth.membership.isManagerRole ||
    auth.membership.roleKey === 'it' ||
    hasPermission(auth.membership.permissions, 'leave.manage')
  );
}

function readPage(c: { req: { query: (name: string) => string | undefined } }) {
  return readListQuery(c);
}

function serializeRequest(row: Awaited<ReturnType<PostgresLeaveStore['listMyRequests']>>['requests'][number]) {
  return {
    id: row.id,
    organization_id: row.organizationId,
    user_id: row.userId,
    leave_type_id: row.leaveTypeId,
    office_id: row.officeId,
    start_date: row.startDate,
    end_date: row.endDate,
    requested_days: row.requestedDays,
    reason: row.reason,
    status: row.status,
    approved_by: row.approvedBy,
    approved_at: row.approvedAt?.toISOString() ?? null,
    rejection_reason: row.rejectionReason,
    request_department: row.requestDepartment,
    request_role: row.requestRole,
    office: row.office,
    balance_deducted_at: row.balanceDeductedAt?.toISOString() ?? null,
    admin_notes: row.adminNotes,
    edited_by: row.editedBy,
    edited_at: row.editedAt?.toISOString() ?? null,
    cancelled_at: row.cancelledAt?.toISOString() ?? null,
    cancelled_by: row.cancelledBy,
    cancellation_reason: row.cancellationReason,
    created_at: row.createdAt.toISOString(),
    requester_name: row.requesterName ?? null,
    requester_email: row.requesterEmail ?? null,
    requester_department: row.office ?? row.requestDepartment,
    requester_role: row.requestRole,
    requester_office_id: row.officeId,
  };
}

export function createLeaveRoutes(dependencies: LeaveRouteDependencies) {
  const routes = new Hono();

  routes.get('/types', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.read');
    const types = await dependencies.store.listTypes(organizationId);
    return c.json({
      types: types.map((row) => ({
        id: row.id,
        organization_id: row.organizationId,
        name: row.name,
        description: row.description,
        default_days: row.defaultDays,
        created_at: row.createdAt.toISOString(),
      })),
    });
  });

  routes.post('/types', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const body = await readJson(c);
    const type = await dependencies.store.createType({
      organizationId,
      name: readRequiredText(body.name, 'name', 120),
      description: readOptionalString(body.description, 'description', 2000),
      defaultDays: Number(body.defaultDays ?? body.default_days ?? 0) || 0,
      isPaid: body.isPaid !== false && body.is_paid !== false,
    });
    return c.json({
      type: {
        id: type.id,
        organization_id: type.organizationId,
        name: type.name,
        description: type.description,
        default_days: type.defaultDays,
        created_at: type.createdAt.toISOString(),
      },
    }, 201);
  });

  routes.get('/balance', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.read');
    const userId = c.req.query('userId') ?? auth.actor.userId;
    if (userId !== auth.actor.userId && !isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const balance = await dependencies.store.getBalance(organizationId, userId);
    return c.json(balance);
  });

  routes.patch('/balance/:userId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const userId = requireUuidValue(c.req.param('userId'), 'userId');
    const body = await readJson(c);
    const totalDays = Number(body.totalDays ?? body.total_days);
    const remainingDays = Number(body.remainingDays ?? body.remaining_days);
    if (!Number.isFinite(totalDays) || !Number.isFinite(remainingDays)) {
      throw new ValidationError('totalDays and remainingDays are required.');
    }
    const balance = await dependencies.store.setBalance({
      organizationId,
      userId,
      actorUserId: auth.actor.userId,
      totalDays,
      remainingDays,
      note: readOptionalString(body.note, 'note', 2000),
    });
    return c.json(balance);
  });

  routes.get('/requests/me', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.read');
    const page = await dependencies.store.listMyRequests(
      organizationId,
      auth.actor.userId,
      readPage(c),
    );
    return c.json({
      requests: page.requests.map(serializeRequest),
      hasMore: page.hasMore,
    });
  });

  routes.get('/requests', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const officeId = c.req.query('officeId') ?? undefined;
    const page = await dependencies.store.listRequests(
      organizationId,
      officeId,
      readPage(c),
    );
    return c.json({
      requests: page.requests.map(serializeRequest),
      hasMore: page.hasMore,
    });
  });

  routes.get('/pending-count', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.read');
    if (!isLeaveStaff(auth)) {
      return c.json({ count: 0 });
    }
    const count = await dependencies.store.countPending(organizationId);
    return c.json({ count });
  });

  routes.post('/requests', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.request');
    const body = await readJson(c);
    const startDate = readRequiredText(body.startDate ?? body.start_date, 'startDate', 32);
    const endDate = readRequiredText(body.endDate ?? body.end_date, 'endDate', 32);
    const office =
      readOptionalString(body.office, 'office', 120) ??
      readOptionalString(body.requestDepartment ?? body.request_department, 'office', 120) ??
      "IT's No Matata";

    const requestedDays = calculateLeaveDaysForOffice({
      startDate,
      endDate,
      office,
    });
    if (requestedDays <= 0) {
      throw new ValidationError(
        `The selected range has no countable leave days for ${office}.`,
      );
    }

    const balance = await dependencies.store.getBalance(
      organizationId,
      auth.actor.userId,
    );
    if (balance.remainingDays <= 0) {
      throw new ValidationError(
        'You have used up all your leave days for the year. You cannot request more leave until your balance is restored.',
      );
    }
    if (requestedDays > balance.remainingDays) {
      throw new ValidationError(
        `This request needs ${requestedDays} day(s), but only ${balance.remainingDays} leave day(s) remain.`,
      );
    }

    const leaveTypeIdRaw = body.leaveTypeId ?? body.leave_type_id;
    const leaveTypeId =
      typeof leaveTypeIdRaw === 'string' && leaveTypeIdRaw.trim()
        ? leaveTypeIdRaw.trim()
        : null;

    const request = await dependencies.store.createRequest({
      organizationId,
      userId: auth.actor.userId,
      leaveTypeId,
      officeId: auth.membership.officeId,
      startDate,
      endDate,
      requestedDays,
      reason: readOptionalString(body.reason, 'reason', 4000),
      requestDepartment: office,
      requestRole:
        readOptionalString(body.requestRole ?? body.request_role, 'requestRole', 80) ??
        auth.membership.roleKey,
      office,
    });

    return c.json({ request: serializeRequest(request) }, 201);
  });

  routes.post('/requests/:requestId/approve', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const requestId = requireUuidValue(c.req.param('requestId'), 'requestId');
    const updated = await dependencies.store.updateRequestStatus({
      organizationId,
      requestId,
      status: 'approved',
      approvedBy: auth.actor.userId,
    });
    if (!updated) {
      throw new NotFoundError('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found.');
    }
    return c.json({ request: serializeRequest(updated) });
  });

  routes.post('/requests/:requestId/reject', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const requestId = requireUuidValue(c.req.param('requestId'), 'requestId');
    const body = await readJson(c).catch(() => ({}));
    const updated = await dependencies.store.updateRequestStatus({
      organizationId,
      requestId,
      status: 'rejected',
      approvedBy: auth.actor.userId,
      rejectionReason: readOptionalString(
        (body as { rejectionReason?: unknown }).rejectionReason ??
          (body as { rejection_reason?: unknown }).rejection_reason,
        'rejectionReason',
        2000,
      ),
    });
    if (!updated) {
      throw new NotFoundError('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found.');
    }
    return c.json({ request: serializeRequest(updated) });
  });

  routes.patch('/requests/:requestId/dates', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const requestId = requireUuidValue(c.req.param('requestId'), 'requestId');
    const body = await readJson(c);
    const startDate = readRequiredText(
      body.startDate ?? body.start_date,
      'startDate',
      32,
    );
    const endDate = readRequiredText(body.endDate ?? body.end_date, 'endDate', 32);
    const existing = await dependencies.store.getRequest(organizationId, requestId);
    if (!existing) {
      throw new NotFoundError('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found.');
    }
    const office =
      readOptionalString(body.office, 'office', 120) ??
      existing.office ??
      existing.requestDepartment ??
      "IT's No Matata";
    const requestedDays = calculateLeaveDaysForOffice({
      startDate,
      endDate,
      office,
    });
    if (requestedDays <= 0) {
      throw new ValidationError(
        `The selected range has no countable leave days for ${office}.`,
      );
    }
    const updated = await dependencies.store.modifyRequestDates({
      organizationId,
      requestId,
      actorUserId: auth.actor.userId,
      startDate,
      endDate,
      requestedDays,
      office,
      reason: readOptionalString(body.reason, 'reason', 2000),
    });
    if (!updated) {
      throw new NotFoundError('LEAVE_REQUEST_NOT_FOUND', 'Leave request was not found.');
    }
    return c.json({ request: serializeRequest(updated) });
  });

  routes.post('/requests/reverse-exhausted', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const result = await dependencies.store.reverseExhaustedPending({
      organizationId,
      actorUserId: auth.actor.userId,
      rejectionReason:
        'You have used up all your leave days for the year. You cannot request more leave until your balance is restored. Please contact an admin if you believe this is a mistake.',
    });
    return c.json(result);
  });

  routes.get('/balance/employees', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const officeId = c.req.query('officeId') ?? undefined;
    const employees = await dependencies.store.listBalanceEmployees({
      organizationId,
      officeId,
    });
    return c.json({
      employees: employees.map((row) => ({
        id: row.id,
        office_id: row.officeId,
        full_name: row.fullName,
        email: row.email,
        primary_role: row.primaryRole,
        leave_days_total: row.leaveDaysTotal,
        leave_days_remaining: row.leaveDaysRemaining,
      })),
    });
  });

  routes.get('/balance/audit', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const userId = c.req.query('userId') ?? undefined;
    const officeId = c.req.query('officeId') ?? undefined;
    const limitRaw = Number(c.req.query('limit') ?? 50);
    const entries = await dependencies.store.listBalanceAudit({
      organizationId,
      userId,
      officeId,
      limit: Number.isFinite(limitRaw) ? limitRaw : 50,
    });
    return c.json({
      entries: entries.map((row) => ({
        id: row.id,
        organization_id: row.organizationId,
        user_id: row.userId,
        modified_by: row.actorUserId,
        previous_total: row.previousTotal,
        previous_remaining: row.previousRemaining,
        new_total: row.newTotal,
        new_remaining: row.newRemaining,
        reason: row.note ?? '',
        created_at: row.createdAt.toISOString(),
        employee: {
          full_name: row.employeeName ?? null,
          email: row.employeeEmail ?? null,
        },
        modifier: {
          full_name: row.modifierName ?? null,
          email: row.modifierEmail ?? null,
        },
      })),
    });
  });

  routes.get('/calendar/rules', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.read');
    const rules = await dependencies.store.listCalendarRules(organizationId);
    return c.json({
      rules: rules.map((rule) => ({
        id: rule.id,
        organization_id: rule.organizationId,
        title: rule.title,
        description: rule.description,
        start_date: rule.startDate,
        end_date: rule.endDate,
        rule_type: rule.ruleType,
        applies_to_role: rule.appliesToRole,
        applies_to_department: rule.appliesToDepartment,
        created_at: rule.createdAt.toISOString(),
      })),
    });
  });

  routes.post('/calendar/rules', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const body = await readJson(c);
    const rule = await dependencies.store.createCalendarRule({
      organizationId,
      title: readRequiredText(body.title, 'title', 200),
      description: readOptionalString(body.description, 'description', 2000),
      startDate: readRequiredText(body.startDate ?? body.start_date, 'startDate', 32),
      endDate: readRequiredText(body.endDate ?? body.end_date, 'endDate', 32),
      ruleType: (body.ruleType ?? body.rule_type) === 'open' ? 'open' : 'closed',
      appliesToRole: readOptionalString(
        body.appliesToRole ?? body.applies_to_role,
        'appliesToRole',
        80,
      ),
      appliesToDepartment: readOptionalString(
        body.appliesToDepartment ?? body.applies_to_department,
        'appliesToDepartment',
        120,
      ),
      createdBy: auth.actor.userId,
    });
    return c.json({
      rule: {
        id: rule.id,
        organization_id: rule.organizationId,
        title: rule.title,
        description: rule.description,
        start_date: rule.startDate,
        end_date: rule.endDate,
        rule_type: rule.ruleType,
        created_at: rule.createdAt.toISOString(),
      },
    }, 201);
  });

  routes.delete('/calendar/rules/:ruleId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.manage');
    if (!isLeaveStaff(auth)) {
      throw new ForbiddenError('LEAVE_ADMIN_REQUIRED', 'Leave admin access required.');
    }
    const ruleId = requireUuidValue(c.req.param('ruleId'), 'ruleId');
    const deleted = await dependencies.store.deleteCalendarRule(
      organizationId,
      ruleId,
    );
    if (!deleted) {
      throw new NotFoundError('LEAVE_RULE_NOT_FOUND', 'Calendar rule was not found.');
    }
    return c.json({ ok: true });
  });

  routes.get('/holidays', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeLeave(auth, 'leave.read');
    const country = c.req.query('country') ?? 'ZW';
    const holidays = await dependencies.store.listHolidays(organizationId, country);
    return c.json({
      holidays: holidays.map((row) => ({
        id: row.id,
        date: row.holidayDate,
        holiday_date: row.holidayDate,
        title: row.title,
        name: row.title,
        country_code: row.countryCode,
      })),
    });
  });

  return routes;
}
