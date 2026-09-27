import { keysetPredicate, listLimit, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type LeaveTypeRecord = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  defaultDays: number;
  isPaid: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type LeaveRequestRecord = {
  id: string;
  organizationId: string;
  userId: string;
  leaveTypeId: string | null;
  officeId: string | null;
  startDate: string;
  endDate: string;
  requestedDays: number;
  reason: string | null;
  status: LeaveRequestStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  requestDepartment: string | null;
  requestRole: string | null;
  office: string | null;
  balanceDeductedAt: Date | null;
  adminNotes: string | null;
  editedBy: string | null;
  editedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  requesterName?: string | null;
  requesterEmail?: string | null;
};

export type LeaveBalanceRecord = {
  totalDays: number;
  remainingDays: number;
  usedDays: number;
};

export type LeaveCalendarRuleRecord = {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string;
  ruleType: 'open' | 'closed';
  appliesToRole: string | null;
  appliesToDepartment: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LeaveHolidayRecord = {
  id: string;
  organizationId: string;
  holidayDate: string;
  title: string;
  countryCode: string;
};

export type LeaveBalanceEmployeeRecord = {
  id: string;
  officeId: string | null;
  fullName: string | null;
  email: string | null;
  primaryRole: string | null;
  leaveDaysTotal: number;
  leaveDaysRemaining: number;
};

export type LeaveBalanceAuditRecord = {
  id: string;
  organizationId: string;
  userId: string;
  actorUserId: string | null;
  previousTotal: number | null;
  previousRemaining: number | null;
  newTotal: number | null;
  newRemaining: number | null;
  note: string | null;
  createdAt: Date;
  employeeName?: string | null;
  employeeEmail?: string | null;
  modifierName?: string | null;
  modifierEmail?: string | null;
};

type TypeRow = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  default_days: number;
  is_paid: boolean;
  created_at: Date;
  updated_at: Date;
};

type RequestRow = {
  id: string;
  organization_id: string;
  user_id: string;
  leave_type_id: string | null;
  office_id: string | null;
  start_date: string;
  end_date: string;
  requested_days: number;
  reason: string | null;
  status: LeaveRequestStatus;
  approved_by: string | null;
  approved_at: Date | null;
  rejection_reason: string | null;
  request_department: string | null;
  request_role: string | null;
  office: string | null;
  balance_deducted_at: Date | null;
  admin_notes: string | null;
  edited_by: string | null;
  edited_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  created_at: Date;
  updated_at: Date;
  requester_name?: string | null;
  requester_email?: string | null;
};

function mapType(row: TypeRow): LeaveTypeRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    defaultDays: row.default_days,
    isPaid: row.is_paid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRequest(row: RequestRow): LeaveRequestRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    leaveTypeId: row.leave_type_id,
    officeId: row.office_id,
    startDate: String(row.start_date).slice(0, 10),
    endDate: String(row.end_date).slice(0, 10),
    requestedDays: row.requested_days,
    reason: row.reason,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectionReason: row.rejection_reason,
    requestDepartment: row.request_department,
    requestRole: row.request_role,
    office: row.office,
    balanceDeductedAt: row.balance_deducted_at,
    adminNotes: row.admin_notes,
    editedBy: row.edited_by,
    editedAt: row.edited_at,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requesterName: row.requester_name ?? null,
    requesterEmail: row.requester_email ?? null,
  };
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

export function calculateLeaveDays(startDate: string, endDate: string) {
  const start = dateOnly(startDate);
  const end = dateOnly(endDate);
  const diff = end.getTime() - start.getTime();
  if (Number.isNaN(diff) || diff < 0) return 0;
  return Math.floor(diff / (24 * 60 * 60 * 1000)) + 1;
}

/** IT's No Matata excludes weekends; Three Little Birds counts all days. */
export function calculateLeaveDaysForOffice(params: {
  startDate: string;
  endDate: string;
  office?: string | null;
}) {
  const normalized = (params.office ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const excludeWeekends = normalized !== 'threelittlebirds';
  if (!excludeWeekends) {
    return calculateLeaveDays(params.startDate, params.endDate);
  }

  let count = 0;
  const cursor = dateOnly(params.startDate);
  const end = dateOnly(params.endDate);
  while (cursor.getTime() <= end.getTime()) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

export class PostgresLeaveStore {
  async listTypes(organizationId: string) {
    const result = await db.query<TypeRow>(
      `SELECT * FROM leave.types
       WHERE organization_id = $1
       ORDER BY name ASC, id ASC
       LIMIT $2`,
      [organizationId, listLimit()],
    );
    return result.rows.map(mapType);
  }

  async createType(input: {
    organizationId: string;
    name: string;
    description?: string | null;
    defaultDays?: number;
    isPaid?: boolean;
  }) {
    const result = await db.query<TypeRow>(
      `INSERT INTO leave.types (
         organization_id, name, description, default_days, is_paid
       ) VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        input.organizationId,
        input.name,
        input.description ?? null,
        input.defaultDays ?? 0,
        input.isPaid ?? true,
      ],
    );
    return mapType(result.rows[0]!);
  }

  async getBalance(organizationId: string, userId: string): Promise<LeaveBalanceRecord> {
    void organizationId;
    const result = await db.query<{
      leave_days_total: number | null;
      leave_days_remaining: number | null;
    }>(
      `SELECT leave_days_total, leave_days_remaining
       FROM identity.user_profiles
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    );
    const totalDays = Number(result.rows[0]?.leave_days_total ?? 22);
    const remainingDays = Number(
      result.rows[0]?.leave_days_remaining ?? totalDays,
    );
    return {
      totalDays,
      remainingDays,
      usedDays: Math.max(totalDays - remainingDays, 0),
    };
  }

  async setBalance(params: {
    organizationId: string;
    userId: string;
    actorUserId: string;
    totalDays: number;
    remainingDays: number;
    note?: string | null;
  }) {
    const previous = await this.getBalance(params.organizationId, params.userId);
    await db.query(
      `UPDATE identity.user_profiles
       SET leave_days_total = $2,
           leave_days_remaining = $3,
           updated_at = NOW()
       WHERE user_id = $1`,
      [params.userId, params.totalDays, params.remainingDays],
    );
    await db.query(
      `INSERT INTO leave.balance_audit (
         organization_id, user_id, actor_user_id,
         previous_total, previous_remaining, new_total, new_remaining, note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        params.organizationId,
        params.userId,
        params.actorUserId,
        previous.totalDays,
        previous.remainingDays,
        params.totalDays,
        params.remainingDays,
        params.note ?? null,
      ],
    );
    return this.getBalance(params.organizationId, params.userId);
  }

  async listMyRequests(
    organizationId: string,
    userId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId, userId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query<RequestRow>(
      `SELECT * FROM leave.requests
       WHERE organization_id = $1 AND user_id = $2
         ${cursor}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map(mapRequest), limit);
    return { requests: paged.rows, hasMore: paged.hasMore };
  }

  async listRequests(
    organizationId: string,
    officeId?: string | null,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId, officeId ?? null];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'r.created_at',
      'r.id',
    );
    params.push(limit + 1);
    const result = await db.query<RequestRow>(
      `SELECT r.*,
              p.full_name AS requester_name,
              u.email AS requester_email
       FROM leave.requests r
       LEFT JOIN identity.user_profiles p ON p.user_id = r.user_id
       LEFT JOIN identity.users u ON u.id = r.user_id
       WHERE r.organization_id = $1
         AND ($2::uuid IS NULL OR r.office_id = $2 OR r.office_id IS NULL)
         ${cursor}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map(mapRequest), limit);
    return { requests: paged.rows, hasMore: paged.hasMore };
  }

  async countPending(organizationId: string) {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM leave.requests
       WHERE organization_id = $1 AND status = 'pending'`,
      [organizationId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getRequest(organizationId: string, requestId: string) {
    const result = await db.query<RequestRow>(
      `SELECT * FROM leave.requests
       WHERE organization_id = $1 AND id = $2
       LIMIT 1`,
      [organizationId, requestId],
    );
    return result.rows[0] ? mapRequest(result.rows[0]) : null;
  }

  async createRequest(input: {
    organizationId: string;
    userId: string;
    leaveTypeId?: string | null;
    officeId?: string | null;
    startDate: string;
    endDate: string;
    requestedDays: number;
    reason?: string | null;
    requestDepartment?: string | null;
    requestRole?: string | null;
    office?: string | null;
  }) {
    const result = await db.query<RequestRow>(
      `INSERT INTO leave.requests (
         organization_id, user_id, leave_type_id, office_id,
         start_date, end_date, requested_days, reason,
         request_department, request_role, office, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
       RETURNING *`,
      [
        input.organizationId,
        input.userId,
        input.leaveTypeId ?? null,
        input.officeId ?? null,
        input.startDate,
        input.endDate,
        input.requestedDays,
        input.reason ?? null,
        input.requestDepartment ?? null,
        input.requestRole ?? null,
        input.office ?? null,
      ],
    );
    return mapRequest(result.rows[0]!);
  }

  async updateRequestStatus(params: {
    organizationId: string;
    requestId: string;
    status: 'approved' | 'rejected';
    approvedBy: string;
    rejectionReason?: string | null;
  }) {
    const existing = await this.getRequest(params.organizationId, params.requestId);
    if (!existing) return null;

    const result = await db.query<RequestRow>(
      `UPDATE leave.requests SET
         status = $3,
         approved_by = $4,
         approved_at = NOW(),
         rejection_reason = $5,
         balance_deducted_at = CASE
           WHEN $3 = 'approved' AND balance_deducted_at IS NULL THEN NOW()
           ELSE balance_deducted_at
         END,
         updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        params.organizationId,
        params.requestId,
        params.status,
        params.approvedBy,
        params.status === 'rejected' ? (params.rejectionReason ?? '') : null,
      ],
    );

    if (params.status === 'approved' && !existing.balanceDeductedAt) {
      await db.query(
        `UPDATE identity.user_profiles
         SET leave_days_remaining = GREATEST(leave_days_remaining - $2, 0),
             updated_at = NOW()
         WHERE user_id = $1`,
        [existing.userId, existing.requestedDays],
      );
    }

    await db.query(
      `INSERT INTO leave.request_audit (
         organization_id, leave_request_id, actor_user_id, action, previous_data, new_data
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        params.organizationId,
        params.requestId,
        params.approvedBy,
        params.status,
        JSON.stringify(existing),
        JSON.stringify(result.rows[0] ?? {}),
      ],
    );

    return result.rows[0] ? mapRequest(result.rows[0]) : null;
  }

  async listCalendarRules(organizationId: string) {
    const result = await db.query(
      `SELECT * FROM leave.calendar_rules
       WHERE organization_id = $1
       ORDER BY start_date ASC, id ASC
       LIMIT 200`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      organizationId: row.organization_id as string,
      title: row.title as string,
      description: (row.description as string | null) ?? null,
      startDate: String(row.start_date).slice(0, 10),
      endDate: String(row.end_date).slice(0, 10),
      ruleType: row.rule_type as 'open' | 'closed',
      appliesToRole: (row.applies_to_role as string | null) ?? null,
      appliesToDepartment: (row.applies_to_department as string | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    })) satisfies LeaveCalendarRuleRecord[];
  }

  async createCalendarRule(input: {
    organizationId: string;
    title: string;
    description?: string | null;
    startDate: string;
    endDate: string;
    ruleType: 'open' | 'closed';
    appliesToRole?: string | null;
    appliesToDepartment?: string | null;
    createdBy: string;
  }) {
    const result = await db.query(
      `INSERT INTO leave.calendar_rules (
         organization_id, title, description, start_date, end_date,
         rule_type, applies_to_role, applies_to_department, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.organizationId,
        input.title,
        input.description ?? null,
        input.startDate,
        input.endDate,
        input.ruleType,
        input.appliesToRole ?? null,
        input.appliesToDepartment ?? null,
        input.createdBy,
      ],
    );
    const row = result.rows[0]!;
    return {
      id: row.id as string,
      organizationId: row.organization_id as string,
      title: row.title as string,
      description: (row.description as string | null) ?? null,
      startDate: String(row.start_date).slice(0, 10),
      endDate: String(row.end_date).slice(0, 10),
      ruleType: row.rule_type as 'open' | 'closed',
      appliesToRole: (row.applies_to_role as string | null) ?? null,
      appliesToDepartment: (row.applies_to_department as string | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    } satisfies LeaveCalendarRuleRecord;
  }

  async deleteCalendarRule(organizationId: string, ruleId: string) {
    const result = await db.query(
      `DELETE FROM leave.calendar_rules
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [organizationId, ruleId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listHolidays(organizationId: string, countryCode = 'ZW') {
    const result = await db.query(
      `SELECT * FROM leave.public_holidays
       WHERE organization_id = $1 AND country_code = $2
       ORDER BY holiday_date ASC, id ASC
       LIMIT 200`,
      [organizationId, countryCode],
    );
    return result.rows.map(
      (row) =>
        ({
          id: row.id as string,
          organizationId: row.organization_id as string,
          holidayDate: String(row.holiday_date).slice(0, 10),
          title: row.title as string,
          countryCode: row.country_code as string,
        }) satisfies LeaveHolidayRecord,
    );
  }

  async modifyRequestDates(params: {
    organizationId: string;
    requestId: string;
    actorUserId: string;
    startDate: string;
    endDate: string;
    requestedDays: number;
    office?: string | null;
    reason?: string | null;
  }) {
    const existing = await this.getRequest(params.organizationId, params.requestId);
    if (!existing) return null;

    const office =
      params.office?.trim() ||
      existing.office ||
      existing.requestDepartment ||
      "IT's No Matata";
    const previousDays = existing.requestedDays;
    const wasApproved = existing.status === 'approved';
    const daysDelta = params.requestedDays - previousDays;

    const metadataPatch = {
      modified_by: params.actorUserId,
      modified_at: new Date().toISOString(),
      modification_reason: params.reason ?? null,
      previous_start_date: existing.startDate,
      previous_end_date: existing.endDate,
      previous_requested_days: previousDays,
    };

    const result = await db.query<RequestRow>(
      `UPDATE leave.requests SET
         start_date = $3,
         end_date = $4,
         requested_days = $5,
         office = $6,
         request_department = $6,
         edited_by = $7,
         edited_at = NOW(),
         metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb,
         updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        params.organizationId,
        params.requestId,
        params.startDate,
        params.endDate,
        params.requestedDays,
        office,
        params.actorUserId,
        JSON.stringify(metadataPatch),
      ],
    );

    if (wasApproved && daysDelta !== 0) {
      const previous = await this.getBalance(
        params.organizationId,
        existing.userId,
      );
      const newRemaining = Math.max(previous.remainingDays - daysDelta, 0);
      await db.query(
        `UPDATE identity.user_profiles
         SET leave_days_remaining = $2,
             updated_at = NOW()
         WHERE user_id = $1`,
        [existing.userId, newRemaining],
      );
      await db.query(
        `INSERT INTO leave.balance_audit (
           organization_id, user_id, actor_user_id,
           previous_total, previous_remaining, new_total, new_remaining, note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          params.organizationId,
          existing.userId,
          params.actorUserId,
          previous.totalDays,
          previous.remainingDays,
          previous.totalDays,
          newRemaining,
          `Approved leave date edit adjusted balance by ${daysDelta} day(s). ${params.reason ?? ''}`.trim(),
        ],
      );
    }

    await db.query(
      `INSERT INTO leave.request_audit (
         organization_id, leave_request_id, actor_user_id, action,
         previous_data, new_data, note
       ) VALUES ($1,$2,$3,'admin_dates_updated',$4::jsonb,$5::jsonb,$6)`,
      [
        params.organizationId,
        params.requestId,
        params.actorUserId,
        JSON.stringify({
          start_date: existing.startDate,
          end_date: existing.endDate,
          requested_days: previousDays,
          office: existing.office,
        }),
        JSON.stringify({
          start_date: params.startDate,
          end_date: params.endDate,
          requested_days: params.requestedDays,
          office,
        }),
        params.reason ?? null,
      ],
    );

    return result.rows[0] ? mapRequest(result.rows[0]) : null;
  }

  async reverseExhaustedPending(params: {
    organizationId: string;
    actorUserId: string;
    rejectionReason: string;
  }) {
    const exhausted = await db.query<{ user_id: string }>(
      `SELECT p.user_id
       FROM identity.user_profiles p
       JOIN organizations.memberships m
         ON m.user_id = p.user_id
        AND m.organization_id = $1
        AND m.status = 'active'
       WHERE COALESCE(p.leave_days_remaining, 0) <= 0`,
      [params.organizationId],
    );
    const exhaustedUserIds = exhausted.rows.map((row) => row.user_id);
    if (exhaustedUserIds.length === 0) return { reversed: 0 };

    const pending = await db.query<RequestRow>(
      `SELECT *
       FROM leave.requests
       WHERE organization_id = $1
         AND status = 'pending'
         AND user_id = ANY($2::uuid[])`,
      [params.organizationId, exhaustedUserIds],
    );
    if (pending.rows.length === 0) return { reversed: 0 };

    const ids = pending.rows.map((row) => row.id);
    await db.query(
      `UPDATE leave.requests SET
         status = 'rejected',
         approved_by = $3,
         approved_at = NOW(),
         rejection_reason = $4,
         updated_at = NOW()
       WHERE organization_id = $1
         AND status = 'pending'
         AND id = ANY($2::uuid[])`,
      [
        params.organizationId,
        ids,
        params.actorUserId,
        params.rejectionReason,
      ],
    );

    for (const row of pending.rows) {
      await db.query(
        `INSERT INTO leave.request_audit (
           organization_id, leave_request_id, actor_user_id, action,
           previous_data, new_data, note
         ) VALUES ($1,$2,$3,'reversed_exhausted_balance',$4::jsonb,$5::jsonb,$6)`,
        [
          params.organizationId,
          row.id,
          params.actorUserId,
          JSON.stringify({ status: 'pending' }),
          JSON.stringify({ status: 'rejected' }),
          params.rejectionReason,
        ],
      );
    }

    return { reversed: ids.length };
  }

  async listBalanceEmployees(params: {
    organizationId: string;
    officeId?: string | null;
  }) {
    const result = await db.query<{
      user_id: string;
      office_id: string | null;
      full_name: string | null;
      email: string | null;
      role_key: string | null;
      leave_days_total: number | null;
      leave_days_remaining: number | null;
    }>(
      `SELECT
         m.user_id,
         COALESCE(m.office_id, p.office_id) AS office_id,
         p.full_name,
         u.email,
         m.role_key,
         p.leave_days_total,
         p.leave_days_remaining
       FROM organizations.memberships m
       JOIN identity.users u ON u.id = m.user_id
       LEFT JOIN identity.user_profiles p ON p.user_id = m.user_id
       WHERE m.organization_id = $1
         AND m.status = 'active'
         AND (
           $2::uuid IS NULL
           OR m.office_id = $2
           OR p.office_id = $2
         )
       ORDER BY p.full_name NULLS LAST, u.email ASC`,
      [params.organizationId, params.officeId ?? null],
    );

    return result.rows.map(
      (row) =>
        ({
          id: row.user_id,
          officeId: row.office_id,
          fullName: row.full_name,
          email: row.email,
          primaryRole: row.role_key,
          leaveDaysTotal: Number(row.leave_days_total ?? 22),
          leaveDaysRemaining: Number(
            row.leave_days_remaining ?? row.leave_days_total ?? 22,
          ),
        }) satisfies LeaveBalanceEmployeeRecord,
    );
  }

  async listBalanceAudit(params: {
    organizationId: string;
    userId?: string | null;
    officeId?: string | null;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const result = await db.query<{
      id: string;
      organization_id: string;
      user_id: string;
      actor_user_id: string | null;
      previous_total: number | null;
      previous_remaining: number | null;
      new_total: number | null;
      new_remaining: number | null;
      note: string | null;
      created_at: Date;
      employee_name: string | null;
      employee_email: string | null;
      modifier_name: string | null;
      modifier_email: string | null;
    }>(
      `SELECT
         a.*,
         ep.full_name AS employee_name,
         eu.email AS employee_email,
         mp.full_name AS modifier_name,
         mu.email AS modifier_email
       FROM leave.balance_audit a
       LEFT JOIN identity.user_profiles ep ON ep.user_id = a.user_id
       LEFT JOIN identity.users eu ON eu.id = a.user_id
       LEFT JOIN identity.user_profiles mp ON mp.user_id = a.actor_user_id
       LEFT JOIN identity.users mu ON mu.id = a.actor_user_id
       WHERE a.organization_id = $1
         AND ($2::uuid IS NULL OR a.user_id = $2)
         AND ($3::uuid IS NULL OR ep.office_id = $3)
       ORDER BY a.created_at DESC
       LIMIT $4`,
      [
        params.organizationId,
        params.userId ?? null,
        params.officeId ?? null,
        limit,
      ],
    );

    return result.rows.map(
      (row) =>
        ({
          id: row.id,
          organizationId: row.organization_id,
          userId: row.user_id,
          actorUserId: row.actor_user_id,
          previousTotal: row.previous_total,
          previousRemaining: row.previous_remaining,
          newTotal: row.new_total,
          newRemaining: row.new_remaining,
          note: row.note,
          createdAt: row.created_at,
          employeeName: row.employee_name,
          employeeEmail: row.employee_email,
          modifierName: row.modifier_name,
          modifierEmail: row.modifier_email,
        }) satisfies LeaveBalanceAuditRecord,
    );
  }
}
