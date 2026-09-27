import { listLimit, listOffset, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

function harareParts(asOf = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(asOf);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(lookup.year), month: Number(lookup.month), day: Number(lookup.day) };
}

function dueOn(year: number, month: number, dueDay: number) {
  const day = Math.min(Math.max(dueDay, 1), 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function statusForDate(due: string, asOfDay: number, dueDay: number) {
  if (asOfDay < dueDay) return 'pending';
  if (asOfDay === dueDay) return 'due';
  return 'overdue';
}

function mapObligation(row: Record<string, unknown>) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    title: row.title,
    description: row.description ?? null,
    due_day_of_month: Number(row.due_day_of_month),
    assignee_id: row.assignee_id,
    created_by: row.created_by ?? null,
    is_active: Boolean(row.is_active),
    archived_at: row.archived_at ? (row.archived_at as Date).toISOString() : null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
    assignee_name: row.assignee_name ?? null,
    assignee_email: row.assignee_email ?? null,
  };
}

function withProgress(
  obligation: ReturnType<typeof mapObligation>,
  occurrence: ReturnType<typeof mapOccurrence> | null,
) {
  const dueDay = obligation.due_day_of_month;
  const { day } = harareParts();
  const progress =
    !occurrence || occurrence.status === 'submitted' || occurrence.status === 'skipped'
      ? occurrence && (occurrence.status === 'submitted' || occurrence.status === 'skipped')
        ? 1
        : 0
      : Math.min(1, Math.max(0, day / dueDay));
  return { ...obligation, occurrence, progress };
}

function mapOccurrence(row: Record<string, unknown>) {
  return {
    id: row.id,
    obligation_id: row.obligation_id,
    organization_id: row.organization_id,
    period_year: Number(row.period_year),
    period_month: Number(row.period_month),
    due_on: String(row.due_on).slice(0, 10),
    status: row.status,
    submitted_at: row.submitted_at ? (row.submitted_at as Date).toISOString() : null,
    submitted_by: row.submitted_by ?? null,
    submission_note: row.submission_note ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

export class PostgresObligationsStore {
  async ensureOccurrences(organizationId: string) {
    const { year, month } = harareParts();
    let nextY = year;
    let nextM = month + 1;
    if (nextM === 13) { nextY += 1; nextM = 1; }
    await db.query(
      `INSERT INTO obligations.occurrences (
         obligation_id, organization_id, period_year, period_month, due_on, status
       )
       SELECT o.id, o.organization_id, $2, $3,
              make_date($2::int, $3::int, LEAST(GREATEST(o.due_day_of_month, 1), 28)),
              'pending'
       FROM obligations.monthly_obligations o
       WHERE o.organization_id = $1 AND o.is_active = TRUE AND o.archived_at IS NULL
       ON CONFLICT (obligation_id, period_year, period_month) DO NOTHING`,
      [organizationId, year, month],
    );
    await db.query(
      `INSERT INTO obligations.occurrences (
         obligation_id, organization_id, period_year, period_month, due_on, status
       )
       SELECT o.id, o.organization_id, $2, $3,
              make_date($2::int, $3::int, LEAST(GREATEST(o.due_day_of_month, 1), 28)),
              'pending'
       FROM obligations.monthly_obligations o
       WHERE o.organization_id = $1 AND o.is_active = TRUE AND o.archived_at IS NULL
       ON CONFLICT (obligation_id, period_year, period_month) DO NOTHING`,
      [organizationId, nextY, nextM],
    );
    await db.query(
      `UPDATE obligations.occurrences
       SET status = CASE
         WHEN due_on::text::date > (timezone('Africa/Harare', now()))::date THEN 'pending'
         WHEN due_on::text::date = (timezone('Africa/Harare', now()))::date THEN 'due'
         ELSE 'overdue'
       END,
       updated_at = NOW()
       WHERE organization_id = $1
         AND period_year = $2 AND period_month = $3
         AND status IN ('pending','due','overdue')`,
      [organizationId, year, month],
    );
  }

  async listObligations(
    organizationId: string,
    assigneeId?: string | null,
    includeArchived = false,
    page: { limit?: number; offset?: number; id?: string } = {},
  ) {
    await this.ensureOccurrences(organizationId);
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    let where = 'o.organization_id = $1';
    if (assigneeId) {
      params.push(assigneeId);
      where += ` AND o.assignee_id = $${params.length}`;
    }
    if (page.id) {
      params.push(page.id);
      where += ` AND o.id = $${params.length}`;
    }
    if (!includeArchived) where += ' AND o.is_active = TRUE AND o.archived_at IS NULL';
    params.push(limit + 1, listOffset(page.offset));
    const result = await db.query(
      `SELECT o.*, p.full_name AS assignee_name, u.email AS assignee_email
       FROM obligations.monthly_obligations o
       LEFT JOIN identity.user_profiles p ON p.user_id = o.assignee_id
       LEFT JOIN identity.users u ON u.id = o.assignee_id
       WHERE ${where}
       ORDER BY o.title ASC, o.id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const paged = pageOf(result.rows.map(mapObligation), limit);
    return { obligations: paged.rows, hasMore: paged.hasMore };
  }

  async listWithCurrentOccurrence(
    organizationId: string,
    assigneeId?: string | null,
    includeArchived = false,
    page: { limit?: number; offset?: number; openOnly?: boolean } = {},
  ) {
    if (page.openOnly) {
      return this.listOpenCurrentOccurrences(organizationId, assigneeId, page);
    }
    const obligations = await this.listObligations(
      organizationId,
      assigneeId,
      includeArchived,
      page,
    );
    const { year, month } = harareParts();
    if (!obligations.obligations.length) {
      return { obligations: [], hasMore: obligations.hasMore };
    }
    const result = await db.query(
      `SELECT * FROM obligations.occurrences
       WHERE organization_id = $1 AND period_year = $2 AND period_month = $3
         AND obligation_id = ANY($4::uuid[])`,
      [organizationId, year, month, obligations.obligations.map((item) => item.id)],
    );
    const map = new Map(result.rows.map((row) => [row.obligation_id, mapOccurrence(row)]));
    return {
      obligations: obligations.obligations.map((obligation) =>
        withProgress(obligation, map.get(obligation.id) ?? null),
      ),
      hasMore: obligations.hasMore,
    };
  }

  private async listOpenCurrentOccurrences(
    organizationId: string,
    assigneeId?: string | null,
    page: { limit?: number; offset?: number } = {},
  ) {
    await this.ensureOccurrences(organizationId);
    const { year, month } = harareParts();
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId, year, month];
    let assignee = '';
    if (assigneeId) {
      params.push(assigneeId);
      assignee = `AND o.assignee_id = $${params.length}`;
    }
    params.push(limit + 1, listOffset(page.offset));
    const result = await db.query(
      `SELECT o.*, p.full_name AS assignee_name, u.email AS assignee_email,
              occ.id AS occ_id, occ.status AS occ_status, occ.due_on AS occ_due_on,
              occ.submitted_at AS occ_submitted_at, occ.submitted_by AS occ_submitted_by,
              occ.submission_note AS occ_submission_note, occ.period_year AS occ_period_year,
              occ.period_month AS occ_period_month, occ.obligation_id AS occ_obligation_id,
              occ.created_at AS occ_created_at, occ.updated_at AS occ_updated_at
       FROM obligations.monthly_obligations o
       JOIN obligations.occurrences occ
         ON occ.obligation_id = o.id
        AND occ.organization_id = o.organization_id
        AND occ.period_year = $2
        AND occ.period_month = $3
        AND occ.status <> 'submitted'
       LEFT JOIN identity.user_profiles p ON p.user_id = o.assignee_id
       LEFT JOIN identity.users u ON u.id = o.assignee_id
       WHERE o.organization_id = $1
         AND o.is_active = TRUE
         AND o.archived_at IS NULL
         ${assignee}
       ORDER BY o.title ASC, o.id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const mapped = result.rows.map((row) => {
      const obligation = mapObligation(row);
      const occurrence = mapOccurrence({
        id: row.occ_id,
        organization_id: organizationId,
        obligation_id: row.occ_obligation_id,
        period_year: row.occ_period_year,
        period_month: row.occ_period_month,
        due_on: row.occ_due_on,
        status: row.occ_status,
        submitted_at: row.occ_submitted_at,
        submitted_by: row.occ_submitted_by,
        submission_note: row.occ_submission_note,
        created_at: row.occ_created_at,
        updated_at: row.occ_updated_at,
      });
      return withProgress(obligation, occurrence);
    });
    const paged = pageOf(mapped, limit);
    return { obligations: paged.rows, hasMore: paged.hasMore };
  }

  async create(input: {
    organizationId: string;
    title: string;
    description?: string | null;
    dueDayOfMonth: number;
    assigneeId: string;
    createdBy: string;
  }) {
    const dueDay = Math.min(Math.max(Math.round(input.dueDayOfMonth), 1), 28);
    const result = await db.query(
      `INSERT INTO obligations.monthly_obligations (
         organization_id, title, description, due_day_of_month, assignee_id, created_by, is_active
       ) VALUES ($1,$2,$3,$4,$5,$6,TRUE)
       RETURNING id`,
      [
        input.organizationId,
        input.title.trim(),
        input.description?.trim() || null,
        dueDay,
        input.assigneeId,
        input.createdBy,
      ],
    );
    await this.ensureOccurrences(input.organizationId);
    const rows = await this.listObligations(input.organizationId, null, true, {
      id: result.rows[0].id,
      limit: 1,
    });
    return rows.obligations[0]!;
  }

  async update(id: string, organizationId: string, patch: Record<string, unknown>) {
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      title: 'title',
      description: 'description',
      dueDayOfMonth: 'due_day_of_month',
      assigneeId: 'assignee_id',
      isActive: 'is_active',
    };
    for (const [key, column] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        let value = patch[key];
        if (key === 'dueDayOfMonth') value = Math.min(Math.max(Math.round(Number(value)), 1), 28);
        if (key === 'isActive') {
          values.push(Boolean(value));
          fields.push(`${column} = $${values.length}`);
          values.push(Boolean(value) ? null : new Date().toISOString());
          fields.push(`archived_at = $${values.length}`);
          continue;
        }
        values.push(value);
        fields.push(`${column} = $${values.length}`);
      }
    }
    if (!fields.length) throw new ValidationError('No obligation fields to update.');
    fields.push('updated_at = NOW()');
    values.push(organizationId, id);
    const result = await db.query(
      `UPDATE obligations.monthly_obligations SET ${fields.join(', ')}
       WHERE organization_id = $${values.length - 1} AND id = $${values.length}
       RETURNING id`,
      values,
    );
    if (!result.rows[0]) throw new NotFoundError('OBLIGATION_NOT_FOUND', 'Obligation not found.');
    const rows = await this.listObligations(organizationId, null, true, {
      id,
      limit: 1,
    });
    return rows.obligations[0]!;
  }

  async submitOccurrence(occurrenceId: string, userId: string, note?: string | null) {
    const result = await db.query(
      `UPDATE obligations.occurrences
       SET status = 'submitted', submitted_at = NOW(), submitted_by = $2,
           submission_note = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [occurrenceId, userId, note ?? null],
    );
    if (!result.rows[0]) throw new NotFoundError('OCCURRENCE_NOT_FOUND', 'Occurrence not found.');
    return mapOccurrence(result.rows[0]);
  }

  async listOccurrencesInRange(organizationId: string, start: string, end: string, assigneeId?: string | null) {
    await this.ensureOccurrences(organizationId);
    const params: unknown[] = [organizationId, start, end];
    let assigneeFilter = '';
    if (assigneeId) {
      params.push(assigneeId);
      assigneeFilter = ` AND o.assignee_id = $${params.length}`;
    }
    const result = await db.query(
      `SELECT occ.*, o.title, o.assignee_id, o.due_day_of_month
       FROM obligations.occurrences occ
       JOIN obligations.monthly_obligations o ON o.id = occ.obligation_id
       WHERE occ.organization_id = $1
         AND occ.due_on >= $2::date AND occ.due_on <= $3::date
         AND o.is_active = TRUE AND o.archived_at IS NULL
         ${assigneeFilter}
       ORDER BY occ.due_on ASC, occ.id ASC
       LIMIT 1000`,
      params,
    );
    return result.rows.map((row) => ({
      ...mapOccurrence(row),
      title: row.title,
      assignee_id: row.assignee_id,
      due_day_of_month: Number(row.due_day_of_month),
    }));
  }
}
