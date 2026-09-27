import { db } from '../db/pool.js';
import { NotFoundError } from '../http/errors.js';

export type DutyRosterRecord = {
  id: string;
  organization_id: string;
  office_id: string | null;
  title: string;
  department: string | null;
  week_start: string;
  status: string;
  rotation_seed: number;
  notes: string | null;
  created_by: string | null;
  archived_at: string | null;
  archived_by: string | null;
  created_at: string;
};

export type DutyDefinitionRecord = {
  id: string;
  organization_id: string;
  office_id: string | null;
  name: string;
  description: string | null;
  duty_type: string;
  category: string;
  frequency: string;
  day_of_week: number | null;
  is_active: boolean;
  allow_managers: boolean;
  allow_bosses: boolean;
  fixed_user_id: string | null;
  fixed_starts_at: string | null;
  fixed_ends_at: string | null;
  fixed_duty_participates_in_friday_rotation: boolean;
  included_roles: string[];
  excluded_roles: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type DutyRosterEntryRecord = {
  id: string;
  roster_id: string;
  user_id: string;
  shift_date: string;
  shift_name: string;
  start_time: string | null;
  end_time: string | null;
  notes: string;
  created_at: string;
};

export type DutyRosterMemberRecord = {
  id: string;
  roster_id: string;
  user_id: string;
  sort_order: number;
  created_at: string;
};

export type DutyRosterDutyRecord = {
  id: string;
  roster_id: string;
  duty_id: string;
  rotation_offset: number;
  sort_order: number;
  assigned_user_id: string | null;
  created_at: string;
};

export type DutyEligibilityOverrideRecord = {
  id: string;
  duty_id: string;
  user_id: string;
  is_excluded: boolean;
  is_forced_included: boolean;
  reason: string | null;
  created_at: string;
};

export type DutyAssignmentHistoryRecord = {
  id: string;
  organization_id: string;
  office_id: string | null;
  roster_id: string;
  duty_id: string;
  user_id: string;
  assignment_week: string;
  assignment_date: string | null;
  source: string;
  created_at: string;
};

export type DutyRosterUserRecord = {
  id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  primary_role: string | null;
  department: string | null;
  office_id: string | null;
};

function dateStr(value: Date | string | null | undefined) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.toISOString();
}

export class PostgresDutyStore {
  async listRosters(
    organizationId: string,
    officeId?: string | null,
  ): Promise<DutyRosterRecord[]> {
    const result = await db.query(
      `
        SELECT id, organization_id, office_id, title, department, week_start,
               status, rotation_seed, notes, created_by, archived_at, archived_by, created_at
        FROM duty.rosters
        WHERE organization_id = $1
          AND ($2::uuid IS NULL OR office_id = $2)
        ORDER BY week_start DESC, id DESC
        LIMIT 200
      `,
      [organizationId, officeId ?? null],
    );
    return result.rows.map((row) => ({
      ...row,
      week_start: dateStr(row.week_start)!,
      archived_at: iso(row.archived_at),
      created_at: iso(row.created_at)!,
    })) as DutyRosterRecord[];
  }

  async getRoster(
    organizationId: string,
    rosterId: string,
  ): Promise<DutyRosterRecord | null> {
    const result = await db.query(
      `
        SELECT id, organization_id, office_id, title, department, week_start,
               status, rotation_seed, notes, created_by, archived_at, archived_by, created_at
        FROM duty.rosters
        WHERE organization_id = $1 AND id = $2
      `,
      [organizationId, rosterId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      week_start: dateStr(row.week_start)!,
      archived_at: iso(row.archived_at),
      created_at: iso(row.created_at)!,
    } as DutyRosterRecord;
  }

  async createRoster(input: {
    organizationId: string;
    officeId?: string | null;
    title: string;
    department?: string | null;
    weekStart: string;
    notes?: string | null;
    rotationSeed?: number;
    createdBy?: string | null;
  }): Promise<DutyRosterRecord> {
    const result = await db.query(
      `
        INSERT INTO duty.rosters (
          organization_id, office_id, title, department, week_start,
          notes, rotation_seed, status, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
        RETURNING id, organization_id, office_id, title, department, week_start,
                  status, rotation_seed, notes, created_by, archived_at, archived_by, created_at
      `,
      [
        input.organizationId,
        input.officeId ?? null,
        input.title,
        input.department ?? null,
        input.weekStart,
        input.notes ?? null,
        input.rotationSeed ?? 0,
        input.createdBy ?? null,
      ],
    );
    const row = result.rows[0];
    return {
      ...row,
      week_start: dateStr(row.week_start)!,
      archived_at: iso(row.archived_at),
      created_at: iso(row.created_at)!,
    } as DutyRosterRecord;
  }

  async updateRoster(input: {
    organizationId: string;
    rosterId: string;
    title?: string;
    department?: string | null;
    notes?: string | null;
    status?: string;
    actorUserId?: string | null;
  }): Promise<DutyRosterRecord> {
    const result = await db.query(
      `
        UPDATE duty.rosters
        SET
          title = COALESCE($3, title),
          department = COALESCE($4, department),
          notes = COALESCE($5, notes),
          status = COALESCE($6, status),
          archived_at = CASE WHEN $6 = 'archived' THEN NOW() ELSE archived_at END,
          archived_by = CASE WHEN $6 = 'archived' THEN $7 ELSE archived_by END,
          updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
        RETURNING id, organization_id, office_id, title, department, week_start,
                  status, rotation_seed, notes, created_by, archived_at, archived_by, created_at
      `,
      [
        input.organizationId,
        input.rosterId,
        input.title ?? null,
        input.department === undefined ? null : input.department,
        input.notes === undefined ? null : input.notes,
        input.status ?? null,
        input.actorUserId ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
    const row = result.rows[0];
    return {
      ...row,
      week_start: dateStr(row.week_start)!,
      archived_at: iso(row.archived_at),
      created_at: iso(row.created_at)!,
    } as DutyRosterRecord;
  }

  async deleteRoster(organizationId: string, rosterId: string): Promise<void> {
    await db.query(
      `DELETE FROM duty.assignment_history WHERE roster_id = $1 AND organization_id = $2`,
      [rosterId, organizationId],
    );
    const result = await db.query(
      `DELETE FROM duty.rosters WHERE organization_id = $1 AND id = $2`,
      [organizationId, rosterId],
    );
    if (result.rowCount === 0) {
      throw new NotFoundError('ROSTER_NOT_FOUND', 'Duty roster was not found.');
    }
  }

  async listEntries(rosterId: string): Promise<DutyRosterEntryRecord[]> {
    const result = await db.query(
      `
        SELECT id, roster_id, user_id, shift_date, shift_name, start_time, end_time, notes, created_at
        FROM duty.roster_entries
        WHERE roster_id = $1
        ORDER BY shift_date ASC
      `,
      [rosterId],
    );
    return result.rows.map((row) => ({
      ...row,
      shift_date: dateStr(row.shift_date)!,
      created_at: iso(row.created_at)!,
    })) as DutyRosterEntryRecord[];
  }

  async createEntry(input: {
    rosterId: string;
    userId: string;
    shiftDate: string;
    shiftName: string;
    startTime?: string | null;
    endTime?: string | null;
    notes?: string;
  }): Promise<DutyRosterEntryRecord> {
    const result = await db.query(
      `
        INSERT INTO duty.roster_entries (
          roster_id, user_id, shift_date, shift_name, start_time, end_time, notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, roster_id, user_id, shift_date, shift_name, start_time, end_time, notes, created_at
      `,
      [
        input.rosterId,
        input.userId,
        input.shiftDate,
        input.shiftName,
        input.startTime ?? null,
        input.endTime ?? null,
        input.notes ?? '',
      ],
    );
    const row = result.rows[0];
    return {
      ...row,
      shift_date: dateStr(row.shift_date)!,
      created_at: iso(row.created_at)!,
    } as DutyRosterEntryRecord;
  }

  async createWeeklyEntries(input: {
    rosterId: string;
    userId: string;
    weekStart: string;
    shiftName: string;
    startTime?: string | null;
    endTime?: string | null;
    notes?: string;
  }): Promise<DutyRosterEntryRecord[]> {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(`${input.weekStart}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + i);
      const shiftDate = date.toISOString().slice(0, 10);
      const base = values.length;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
      );
      values.push(
        input.rosterId,
        input.userId,
        shiftDate,
        input.shiftName,
        input.startTime ?? null,
        input.endTime ?? null,
        input.notes ?? '',
      );
    }
    const result = await db.query(
      `
        INSERT INTO duty.roster_entries (
          roster_id, user_id, shift_date, shift_name, start_time, end_time, notes
        )
        VALUES ${placeholders.join(', ')}
        RETURNING id, roster_id, user_id, shift_date, shift_name, start_time, end_time, notes, created_at
      `,
      values,
    );
    return result.rows.map((row) => ({
      ...row,
      shift_date: dateStr(row.shift_date)!,
      created_at: iso(row.created_at)!,
    })) as DutyRosterEntryRecord[];
  }

  async listDefinitions(
    organizationId: string,
    officeId?: string | null,
  ): Promise<DutyDefinitionRecord[]> {
    const result = await db.query(
      `
        SELECT *
        FROM duty.definitions
        WHERE organization_id = $1
          AND ($2::uuid IS NULL OR office_id = $2)
        ORDER BY created_at ASC
      `,
      [organizationId, officeId ?? null],
    );
    return result.rows.map((row) => ({
      ...row,
      fixed_starts_at: dateStr(row.fixed_starts_at),
      fixed_ends_at: dateStr(row.fixed_ends_at),
      included_roles: row.included_roles ?? [],
      excluded_roles: row.excluded_roles ?? [],
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
    })) as DutyDefinitionRecord[];
  }

  async upsertDefinition(input: Record<string, unknown>): Promise<DutyDefinitionRecord> {
    const id = input.id as string | undefined;
    const params = [
      input.organizationId,
      input.officeId,
      input.name,
      input.description ?? null,
      input.dutyType ?? 'weekly_rotating',
      input.category ?? 'normal_rotation',
      input.frequency ?? 'weekly',
      input.dayOfWeek ?? null,
      input.isActive ?? true,
      input.allowManagers ?? true,
      input.allowBosses ?? true,
      input.fixedUserId ?? null,
      input.fixedStartsAt ?? null,
      input.fixedEndsAt ?? null,
      input.fixedDutyParticipatesInFridayRotation ?? true,
      input.includedRoles ?? [],
      input.excludedRoles ?? [],
      input.createdBy ?? null,
    ];

    const result = id
      ? await db.query(
          `
            UPDATE duty.definitions SET
              name = $3, description = $4, duty_type = $5, category = $6,
              frequency = $7, day_of_week = $8, is_active = $9,
              allow_managers = $10, allow_bosses = $11, fixed_user_id = $12,
              fixed_starts_at = $13, fixed_ends_at = $14,
              fixed_duty_participates_in_friday_rotation = $15,
              included_roles = $16, excluded_roles = $17, updated_at = NOW()
            WHERE id = $19 AND organization_id = $1
            RETURNING *
          `,
          [...params, id],
        )
      : await db.query(
          `
            INSERT INTO duty.definitions (
              organization_id, office_id, name, description, duty_type, category,
              frequency, day_of_week, is_active, allow_managers, allow_bosses,
              fixed_user_id, fixed_starts_at, fixed_ends_at,
              fixed_duty_participates_in_friday_rotation, included_roles,
              excluded_roles, created_by
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            RETURNING *
          `,
          params,
        );

    if (!result.rows[0]) {
      throw new NotFoundError('DUTY_NOT_FOUND', 'Duty definition was not found.');
    }
    const row = result.rows[0];
    return {
      ...row,
      fixed_starts_at: dateStr(row.fixed_starts_at),
      fixed_ends_at: dateStr(row.fixed_ends_at),
      included_roles: row.included_roles ?? [],
      excluded_roles: row.excluded_roles ?? [],
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
    } as DutyDefinitionRecord;
  }

  async listMembers(rosterId: string): Promise<DutyRosterMemberRecord[]> {
    const result = await db.query(
      `
        SELECT id, roster_id, user_id, sort_order, created_at
        FROM duty.roster_members
        WHERE roster_id = $1
        ORDER BY sort_order ASC
      `,
      [rosterId],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at)!,
    })) as DutyRosterMemberRecord[];
  }

  async setMembers(
    rosterId: string,
    userIds: string[],
  ): Promise<DutyRosterMemberRecord[]> {
    await db.query(`DELETE FROM duty.roster_members WHERE roster_id = $1`, [
      rosterId,
    ]);
    if (userIds.length === 0) return [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    userIds.forEach((userId, index) => {
      const base = values.length;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      values.push(rosterId, userId, index);
    });
    const result = await db.query(
      `
        INSERT INTO duty.roster_members (roster_id, user_id, sort_order)
        VALUES ${placeholders.join(', ')}
        RETURNING id, roster_id, user_id, sort_order, created_at
      `,
      values,
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at)!,
    })) as DutyRosterMemberRecord[];
  }

  async listRosterDuties(rosterId: string): Promise<DutyRosterDutyRecord[]> {
    const result = await db.query(
      `
        SELECT id, roster_id, duty_id, rotation_offset, sort_order, assigned_user_id, created_at
        FROM duty.roster_duties
        WHERE roster_id = $1
        ORDER BY sort_order ASC
      `,
      [rosterId],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at)!,
    })) as DutyRosterDutyRecord[];
  }

  async setRosterDuties(
    rosterId: string,
    duties: Array<{ dutyId: string; assignedUserId?: string | null }>,
  ): Promise<DutyRosterDutyRecord[]> {
    await db.query(`DELETE FROM duty.roster_duties WHERE roster_id = $1`, [
      rosterId,
    ]);
    if (duties.length === 0) return [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    duties.forEach((item, index) => {
      const base = values.length;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
      );
      values.push(
        rosterId,
        item.dutyId,
        index,
        index,
        item.assignedUserId ?? null,
      );
    });
    const result = await db.query(
      `
        INSERT INTO duty.roster_duties (
          roster_id, duty_id, rotation_offset, sort_order, assigned_user_id
        )
        VALUES ${placeholders.join(', ')}
        RETURNING id, roster_id, duty_id, rotation_offset, sort_order, assigned_user_id, created_at
      `,
      values,
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at)!,
    })) as DutyRosterDutyRecord[];
  }

  async listEligibilityOverrides(
    dutyIds: string[],
  ): Promise<DutyEligibilityOverrideRecord[]> {
    if (dutyIds.length === 0) return [];
    const result = await db.query(
      `
        SELECT id, duty_id, user_id, is_excluded, is_forced_included, reason, created_at
        FROM duty.eligibility_overrides
        WHERE duty_id = ANY($1::uuid[])
      `,
      [dutyIds],
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at)!,
    })) as DutyEligibilityOverrideRecord[];
  }

  async setEligibilityOverrides(
    dutyId: string,
    overrides: Array<{
      userId: string;
      isExcluded?: boolean;
      isForcedIncluded?: boolean;
      reason?: string | null;
    }>,
  ): Promise<DutyEligibilityOverrideRecord[]> {
    await db.query(
      `DELETE FROM duty.eligibility_overrides WHERE duty_id = $1`,
      [dutyId],
    );
    const normalized = overrides.filter(
      (item) => item.isExcluded || item.isForcedIncluded,
    );
    if (normalized.length === 0) return [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    normalized.forEach((item) => {
      const base = values.length;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`,
      );
      values.push(
        dutyId,
        item.userId,
        Boolean(item.isExcluded && !item.isForcedIncluded),
        Boolean(item.isForcedIncluded),
        item.reason ?? null,
      );
    });
    const result = await db.query(
      `
        INSERT INTO duty.eligibility_overrides (
          duty_id, user_id, is_excluded, is_forced_included, reason
        )
        VALUES ${placeholders.join(', ')}
        RETURNING id, duty_id, user_id, is_excluded, is_forced_included, reason, created_at
      `,
      values,
    );
    return result.rows.map((row) => ({
      ...row,
      created_at: iso(row.created_at)!,
    })) as DutyEligibilityOverrideRecord[];
  }

  async listAssignmentHistory(params: {
    rosterId: string;
    beforeWeek?: string;
    weekStart?: string;
  }): Promise<DutyAssignmentHistoryRecord[]> {
    const result = await db.query(
      `
        SELECT id, organization_id, office_id, roster_id, duty_id, user_id,
               assignment_week, assignment_date, source, created_at
        FROM duty.assignment_history
        WHERE roster_id = $1
          AND ($2::date IS NULL OR assignment_week = $2)
          AND ($3::date IS NULL OR assignment_week < $3)
        ORDER BY assignment_week DESC, id DESC
        LIMIT 200
      `,
      [params.rosterId, params.weekStart ?? null, params.beforeWeek ?? null],
    );
    return result.rows.map((row) => ({
      ...row,
      assignment_week: dateStr(row.assignment_week)!,
      assignment_date: dateStr(row.assignment_date),
      created_at: iso(row.created_at)!,
    })) as DutyAssignmentHistoryRecord[];
  }

  async persistAssignments(
    assignments: Array<{
      organizationId: string;
      officeId?: string | null;
      rosterId: string;
      dutyId: string;
      userId: string;
      assignmentWeek: string;
      assignmentDate?: string | null;
      source?: string;
    }>,
  ): Promise<void> {
    if (assignments.length === 0) return;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    assignments.forEach((item) => {
      const base = values.length;
      placeholders.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`,
      );
      values.push(
        item.organizationId,
        item.officeId ?? null,
        item.rosterId,
        item.dutyId,
        item.userId,
        item.assignmentWeek,
        item.assignmentDate ?? null,
        item.source ?? 'generated',
      );
    });
    await db.query(
      `
        INSERT INTO duty.assignment_history (
          organization_id, office_id, roster_id, duty_id, user_id,
          assignment_week, assignment_date, source
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (roster_id, duty_id, assignment_week)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          assignment_date = EXCLUDED.assignment_date,
          source = EXCLUDED.source
      `,
      values,
    );
  }

  async listUsersForRoster(
    organizationId: string,
    officeId?: string | null,
  ): Promise<DutyRosterUserRecord[]> {
    const result = await db.query(
      `
        SELECT
          u.id,
          p.full_name,
          u.email,
          p.avatar_url,
          COALESCE(m.role_key, p.primary_role_key) AS primary_role,
          p.department,
          m.office_id
        FROM organizations.memberships m
        JOIN identity.users u ON u.id = m.user_id
        LEFT JOIN identity.user_profiles p ON p.user_id = u.id
        WHERE m.organization_id = $1
          AND m.status = 'active'
          AND u.account_status = 'active'
          AND u.is_active = TRUE
          AND ($2::uuid IS NULL OR m.office_id = $2)
        ORDER BY p.full_name NULLS LAST, u.email
      `,
      [organizationId, officeId ?? null],
    );
    return result.rows as DutyRosterUserRecord[];
  }
}
