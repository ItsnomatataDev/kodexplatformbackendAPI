import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { calendarDateKey, dateKey } from './dates.js';
import { expandWeeklyOffDates } from './weekly-off.js';

function mapRowDates(row: Record<string, unknown>, keys: string[]) {
  const out = { ...row };
  for (const key of keys) {
    const value = out[key];
    if (value instanceof Date) {
      // toISOString() shifts a local-midnight DATE back a day in Harare and
      // produces a timestamp the planner UI cannot format.
      out[key] = /_date$/.test(key) ? calendarDateKey(value) : value.toISOString();
    } else if (value != null && /_date$/.test(key)) out[key] = String(value).slice(0, 10);
    else if (value != null && /_time$/.test(key)) out[key] = String(value).slice(0, 8);
  }
  return out;
}

export class PostgresLocationPlannerStore {
  async getAdminCalendar(params: {
    organizationId: string;
    startDate: string;
    endDate: string;
    locationId?: string | null;
    roleId?: string | null;
    employeeId?: string | null;
  }) {
    const [locations, roles, statusEvents, slots, assignments, skills, offDays, weekly] = await Promise.all([
      db.query(`SELECT * FROM location_planner.locations WHERE organization_id = $1 AND is_active = TRUE ORDER BY name, id LIMIT 200`, [params.organizationId]),
      db.query(`SELECT * FROM location_planner.roles WHERE organization_id = $1 AND is_active = TRUE ORDER BY name, id LIMIT 200`, [params.organizationId]),
      db.query(
        `SELECT * FROM location_planner.status_events
         WHERE organization_id = $1 AND end_date >= $2::date AND start_date <= $3::date
         ORDER BY start_date, id
         LIMIT 2000`,
        [params.organizationId, params.startDate, params.endDate],
      ),
      db.query(
        `SELECT * FROM location_planner.assignment_slots
         WHERE organization_id = $1 AND end_date >= $2::date AND start_date <= $3::date
           AND ($4::uuid IS NULL OR location_id = $4)
           AND ($5::uuid IS NULL OR temporary_role_id = $5)
         ORDER BY start_date
         LIMIT 2000`,
        [params.organizationId, params.startDate, params.endDate, params.locationId ?? null, params.roleId ?? null],
      ),
      db.query(
        `SELECT * FROM location_planner.employee_assignments
         WHERE organization_id = $1 AND end_date >= $2::date AND start_date <= $3::date
           AND status <> 'cancelled'
           AND ($4::uuid IS NULL OR location_id = $4)
           AND ($5::uuid IS NULL OR temporary_role_id = $5)
           AND ($6::uuid IS NULL OR employee_id = $6)
         ORDER BY start_date
         LIMIT 2000`,
        [params.organizationId, params.startDate, params.endDate, params.locationId ?? null, params.roleId ?? null, params.employeeId ?? null],
      ),
      db.query(`SELECT * FROM location_planner.employee_skills WHERE organization_id = $1 ORDER BY employee_id LIMIT 2000`, [params.organizationId]),
      db.query(
        `SELECT * FROM location_planner.tlb_off_days
         WHERE organization_id = $1 AND off_date >= $2::date AND off_date <= $3::date
         ORDER BY off_date
         LIMIT 2000`,
        [params.organizationId, params.startDate, params.endDate],
      ),
      db.query(
        `SELECT * FROM location_planner.tlb_weekly_off_days
         WHERE organization_id = $1 AND is_active = TRUE
         LIMIT 200`,
        [params.organizationId],
      ),
    ]);

    const members = await db.query(
      `SELECT u.id, p.full_name, u.email, m.role_key AS primary_role, p.department
       FROM organizations.memberships m
       JOIN identity.users u ON u.id = m.user_id
       LEFT JOIN identity.user_profiles p ON p.user_id = u.id
       WHERE m.organization_id = $1
         AND m.status = 'active'
         AND COALESCE(u.account_status, 'active') <> 'deleted'
       ORDER BY p.full_name NULLS LAST, u.email
       LIMIT 2000`,
      [params.organizationId],
    );
    const skillsByEmployee = new Map<string, string[]>();
    for (const row of skills.rows) {
      const id = String(row.employee_id);
      const list = skillsByEmployee.get(id) ?? [];
      list.push(String(row.skill));
      skillsByEmployee.set(id, list);
    }
    const employees = members.rows.map((row) => ({
      id: row.id,
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      primary_role: row.primary_role ?? null,
      department: row.department ?? null,
      skills: skillsByEmployee.get(String(row.id)) ?? [],
    }));

    const nameById = new Map(
      employees.map((e) => [
        String(e.id),
        (e.full_name as string | null) ?? (e.email as string | null) ?? null,
      ]),
    );

    const oneOffAvailability = offDays.rows.map((row) => ({
      id: row.id,
      user_id: row.employee_id,
      kind: 'off_day' as const,
      source: 'one_off' as const,
      start_date: dateKey(row.off_date),
      end_date: dateKey(row.off_date),
      title: 'Off day',
      reason: row.reason ?? null,
      employee_name: nameById.get(String(row.employee_id)) ?? null,
      employee_email: null,
    }));

    const weeklyAvailability = weekly.rows.flatMap((row) => {
      const weekday = Number(row.weekday);
      return expandWeeklyOffDates(params.startDate, params.endDate, weekday).map((date) => ({
        id: `${row.id}:${date}`,
        user_id: row.employee_id,
        kind: 'off_day' as const,
        source: 'weekly' as const,
        recurrence_rule_id: row.id,
        start_date: date,
        end_date: date,
        title: 'Weekly off',
        reason: row.reason ?? null,
        employee_name: nameById.get(String(row.employee_id)) ?? null,
        employee_email: null,
        weekday,
      }));
    });

    const locationNameById = new Map(
      locations.rows.map((l) => [String(l.id), String(l.name ?? '')]),
    );
    const locationStatusById = new Map(
      locations.rows.map((l) => [String(l.id), String(l.status ?? 'open')]),
    );
    const roleNameById = new Map(
      roles.rows.map((r) => [String(r.id), String(r.name ?? '')]),
    );
    const emailById = new Map(
      employees.map((e) => [String(e.id), (e.email as string | null) ?? null]),
    );

    const availability = [...oneOffAvailability, ...weeklyAvailability];

    const shapedAssignments = assignments.rows.map((row) => {
      const assignment = mapRowDates(row, [
        'start_date',
        'end_date',
        'start_time',
        'end_time',
        'created_at',
        'updated_at',
        'confirmed_at',
      ]);
      const employeeId = String(row.employee_id);
      const locationId = String(row.location_id);
      const roleId = row.temporary_role_id ? String(row.temporary_role_id) : null;
      return {
        assignment,
        employee_id: employeeId,
        employee_name: nameById.get(employeeId) ?? null,
        employee_email: emailById.get(employeeId) ?? null,
        location_name: locationNameById.get(locationId) ?? '',
        location_status: locationStatusById.get(locationId) ?? 'open',
        role_name: roleId ? roleNameById.get(roleId) ?? null : null,
        is_mine: false,
      };
    });

    return {
      locations: locations.rows,
      roles: roles.rows,
      status_events: statusEvents.rows.map((r) => mapRowDates(r, ['start_date', 'end_date', 'created_at', 'updated_at'])),
      slots: slots.rows.map((r) => mapRowDates(r, ['start_date', 'end_date', 'start_time', 'end_time', 'created_at', 'updated_at'])),
      assignments: shapedAssignments,
      employees,
      availability,
      skills: skills.rows,
    };
  }

  async getEmployeeCalendar(params: {
    organizationId: string;
    userId: string;
    startDate: string;
    endDate: string;
    locationId?: string | null;
  }) {
    const admin = await this.getAdminCalendar({
      organizationId: params.organizationId,
      startDate: params.startDate,
      endDate: params.endDate,
      locationId: params.locationId,
    });
    return {
      viewer_id: params.userId,
      locations: admin.locations,
      status_events: admin.status_events,
      assignments: admin.assignments.map((assignment) => ({
        ...assignment,
        is_mine:
          assignment.employee_id === params.userId ||
          assignment.assignment.employee_id === params.userId,
      })),
      availability: admin.availability,
    };
  }

  async listLocations(organizationId: string) {
    const result = await db.query(
      `SELECT * FROM location_planner.locations WHERE organization_id = $1 ORDER BY name, id LIMIT 200`,
      [organizationId],
    );
    return result.rows;
  }

  async upsertLocation(organizationId: string, input: Record<string, unknown>, id?: string) {
    if (id) {
      const result = await db.query(
        `UPDATE location_planner.locations
         SET name = COALESCE($3, name),
             type = COALESCE($4, type),
             status = COALESCE($5, status),
             capacity = COALESCE($6, capacity),
             notes = COALESCE($7, notes),
             is_active = COALESCE($8, is_active),
             updated_at = NOW()
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [organizationId, id, input.name ?? null, input.type ?? null, input.status ?? null, input.capacity ?? null, input.notes ?? null, input.is_active ?? null],
      );
      if (!result.rows[0]) throw new NotFoundError('LOCATION_NOT_FOUND', 'Location not found.');
      return result.rows[0];
    }
    const result = await db.query(
      `INSERT INTO location_planner.locations (
         organization_id, name, type, status, capacity, notes, is_active
       ) VALUES ($1,$2,COALESCE($3,'department'),COALESCE($4,'open'),$5,$6,COALESCE($7,TRUE))
       RETURNING *`,
      [organizationId, input.name, input.type ?? 'department', input.status ?? 'open', input.capacity ?? null, input.notes ?? null, input.is_active ?? true],
    );
    return result.rows[0];
  }

  async listRoles(organizationId: string) {
    const result = await db.query(
      `SELECT * FROM location_planner.roles WHERE organization_id = $1 ORDER BY name, id LIMIT 200`,
      [organizationId],
    );
    return result.rows;
  }

  async upsertRole(organizationId: string, input: Record<string, unknown>, id?: string) {
    if (id) {
      const result = await db.query(
        `UPDATE location_planner.roles
         SET name = COALESCE($3, name),
             category = COALESCE($4, category),
             description = COALESCE($5, description),
             location_id = COALESCE($6, location_id),
             required_skills = COALESCE($7, required_skills),
             is_temporary = COALESCE($8, is_temporary),
             is_active = COALESCE($9, is_active),
             updated_at = NOW()
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [organizationId, id, input.name ?? null, input.category ?? null, input.description ?? null, input.location_id ?? null, input.required_skills ?? null, input.is_temporary ?? null, input.is_active ?? null],
      );
      if (!result.rows[0]) throw new NotFoundError('ROLE_NOT_FOUND', 'Role not found.');
      return result.rows[0];
    }
    const result = await db.query(
      `INSERT INTO location_planner.roles (
         organization_id, name, category, description, location_id, required_skills, is_temporary, is_active
       ) VALUES ($1,$2,$3,$4,$5,COALESCE($6,'{}'),COALESCE($7,FALSE),COALESCE($8,TRUE))
       RETURNING *`,
      [organizationId, input.name, input.category ?? null, input.description ?? null, input.location_id ?? null, input.required_skills ?? [], input.is_temporary ?? false, input.is_active ?? true],
    );
    return result.rows[0];
  }

  async createSlot(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO location_planner.assignment_slots (
         organization_id, location_id, title, temporary_role_id, required_count,
         start_date, end_date, start_time, end_time, required_skills, priority, notes, status, created_by
       ) VALUES ($1,$2,$3,$4,COALESCE($5,1),$6,$7,$8,$9,COALESCE($10,'{}'),COALESCE($11,'normal'),$12,COALESCE($13,'open'),$14)
       RETURNING *`,
      [
        organizationId,
        input.location_id ?? input.locationId,
        input.title,
        input.temporary_role_id ?? input.temporaryRoleId ?? null,
        input.required_count ?? input.requiredCount ?? 1,
        input.start_date ?? input.startDate,
        input.end_date ?? input.endDate,
        input.start_time ?? input.startTime ?? null,
        input.end_time ?? input.endTime ?? null,
        input.required_skills ?? input.requiredSkills ?? [],
        input.priority ?? 'normal',
        input.notes ?? null,
        input.status ?? 'open',
        createdBy,
      ],
    );
    return mapRowDates(result.rows[0], ['start_date', 'end_date', 'start_time', 'end_time', 'created_at', 'updated_at']);
  }

  async deleteSlot(organizationId: string, slotId: string) {
    const result = await db.query(
      `DELETE FROM location_planner.assignment_slots WHERE organization_id = $1 AND id = $2 RETURNING id`,
      [organizationId, slotId],
    );
    if (!result.rows[0]) throw new NotFoundError('SLOT_NOT_FOUND', 'Slot not found.');
  }

  async assignEmployee(organizationId: string, createdBy: string, input: Record<string, unknown>) {
    const result = await db.query(
      `INSERT INTO location_planner.employee_assignments (
         organization_id, employee_id, slot_id, location_id, temporary_role_id,
         start_date, end_date, start_time, end_time, status, notes, created_by, confirmed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'confirmed'),$11,$12,NOW())
       RETURNING *`,
      [
        organizationId,
        input.employee_id ?? input.employeeId,
        input.slot_id ?? input.slotId ?? null,
        input.location_id ?? input.locationId,
        input.temporary_role_id ?? input.temporaryRoleId ?? null,
        input.start_date ?? input.startDate,
        input.end_date ?? input.endDate,
        input.start_time ?? input.startTime ?? null,
        input.end_time ?? input.endTime ?? null,
        input.status ?? 'confirmed',
        input.notes ?? null,
        createdBy,
      ],
    );
    return mapRowDates(result.rows[0], ['start_date', 'end_date', 'start_time', 'end_time', 'created_at', 'updated_at', 'confirmed_at']);
  }

  async updateAssignment(organizationId: string, assignmentId: string, input: Record<string, unknown>) {
    const result = await db.query(
      `UPDATE location_planner.employee_assignments
       SET location_id = COALESCE($3, location_id),
           temporary_role_id = COALESCE($4, temporary_role_id),
           start_date = COALESCE($5, start_date),
           end_date = COALESCE($6, end_date),
           start_time = COALESCE($7, start_time),
           end_time = COALESCE($8, end_time),
           status = COALESCE($9, status),
           notes = COALESCE($10, notes),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        organizationId,
        assignmentId,
        input.location_id ?? input.locationId ?? null,
        input.temporary_role_id ?? input.temporaryRoleId ?? null,
        input.start_date ?? input.startDate ?? null,
        input.end_date ?? input.endDate ?? null,
        input.start_time ?? input.startTime ?? null,
        input.end_time ?? input.endTime ?? null,
        input.status ?? null,
        input.notes ?? null,
      ],
    );
    if (!result.rows[0]) throw new NotFoundError('ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
    return mapRowDates(result.rows[0], ['start_date', 'end_date', 'start_time', 'end_time', 'created_at', 'updated_at', 'confirmed_at']);
  }

  async deleteAssignment(organizationId: string, assignmentId: string) {
    const result = await db.query(
      `UPDATE location_planner.employee_assignments
       SET status = 'cancelled', updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING id`,
      [organizationId, assignmentId],
    );
    if (!result.rows[0]) throw new NotFoundError('ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
  }

  async setOffDay(organizationId: string, employeeId: string, offDate: string, reason: string | null, createdBy: string) {
    const result = await db.query(
      `INSERT INTO location_planner.tlb_off_days (organization_id, employee_id, off_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id, employee_id, off_date)
       DO UPDATE SET reason = EXCLUDED.reason
       RETURNING *`,
      [organizationId, employeeId, offDate, reason, createdBy],
    );
    return result.rows[0];
  }

  /**
   * Copy the most recent complete Mon–Sun week onto empty days from fillFrom through monthEnd.
   * Skips days that already have any non-cancelled assignment, and people marked off that weekday/date.
   */
  async fillMonthSchedule(
    organizationId: string,
    createdBy: string | null,
    input: { monthStart: string; fromDate?: string | null },
  ) {
    const monthStart = String(input.monthStart).slice(0, 10);
    const monthStartDate = new Date(`${monthStart}T12:00:00.000Z`);
    if (Number.isNaN(monthStartDate.getTime())) {
      throw new ValidationError('monthStart must be a valid YYYY-MM-DD date.');
    }
    const monthEndDate = new Date(
      Date.UTC(monthStartDate.getUTCFullYear(), monthStartDate.getUTCMonth() + 1, 0, 12),
    );
    const monthEnd = monthEndDate.toISOString().slice(0, 10);
    const fillFromRaw = input.fromDate ? String(input.fromDate).slice(0, 10) : monthStart;
    const fillFrom = fillFromRaw < monthStart ? monthStart : fillFromRaw > monthEnd ? monthEnd : fillFromRaw;

    const pattern = await db.query<{ start_date: string }>(
      `SELECT start_date::text AS start_date
       FROM location_planner.employee_assignments
       WHERE organization_id = $1
         AND status <> 'cancelled'
         AND start_date < $2::date
       GROUP BY start_date
       HAVING COUNT(*) > 0
       ORDER BY start_date DESC
       LIMIT 14`,
      [organizationId, fillFrom],
    );
    if (!pattern.rows.length) {
      throw new ValidationError('No prior week pattern found to copy.');
    }

    // Prefer a contiguous 7-day window ending at the latest source day.
    const sourceDates = pattern.rows.map((r) => r.start_date).sort();
    const latest = sourceDates[sourceDates.length - 1]!;
    const latestDate = new Date(`${latest}T12:00:00.000Z`);
    const patternStartDate = new Date(latestDate);
    patternStartDate.setUTCDate(patternStartDate.getUTCDate() - 6);
    const patternStart = patternStartDate.toISOString().slice(0, 10);
    const patternEnd = latest;

    const sourceRows = await db.query(
      `SELECT employee_id, slot_id, location_id, temporary_role_id,
              start_date, start_time, end_time, status, notes,
              EXTRACT(DOW FROM start_date)::int AS weekday
       FROM location_planner.employee_assignments
       WHERE organization_id = $1
         AND status <> 'cancelled'
         AND start_date >= $2::date
         AND start_date <= $3::date`,
      [organizationId, patternStart, patternEnd],
    );

    const byWeekday = new Map<number, typeof sourceRows.rows>();
    for (const row of sourceRows.rows) {
      const weekday = Number(row.weekday);
      const bucket = byWeekday.get(weekday) ?? [];
      bucket.push(row);
      byWeekday.set(weekday, bucket);
    }

    let daysFilled = 0;
    let insertedCount = 0;
    let skippedCount = 0;
    const cursor = new Date(`${fillFrom}T12:00:00.000Z`);
    const end = new Date(`${monthEnd}T12:00:00.000Z`);

    while (cursor <= end) {
      const targetDate = cursor.toISOString().slice(0, 10);
      const weekday = cursor.getUTCDay();
      const existing = await db.query(
        `SELECT 1 FROM location_planner.employee_assignments
         WHERE organization_id = $1 AND status <> 'cancelled'
           AND start_date <= $2::date AND end_date >= $2::date
         LIMIT 1`,
        [organizationId, targetDate],
      );
      if (existing.rows[0]) {
        skippedCount += 1;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        continue;
      }

      const templates = byWeekday.get(weekday) ?? [];
      let dayInserted = 0;
      for (const template of templates) {
        const employeeId = String(template.employee_id);
        const weeklyOff = await db.query(
          `SELECT 1 FROM location_planner.tlb_weekly_off_days
           WHERE organization_id = $1 AND employee_id = $2 AND weekday = $3 AND is_active = TRUE
           LIMIT 1`,
          [organizationId, employeeId, weekday],
        );
        const oneOff = await db.query(
          `SELECT 1 FROM location_planner.tlb_off_days
           WHERE organization_id = $1 AND employee_id = $2 AND off_date = $3::date
           LIMIT 1`,
          [organizationId, employeeId, targetDate],
        );
        if (weeklyOff.rows[0] || oneOff.rows[0]) {
          skippedCount += 1;
          continue;
        }

        await db.query(
          `INSERT INTO location_planner.employee_assignments (
             organization_id, employee_id, slot_id, location_id, temporary_role_id,
             start_date, end_date, start_time, end_time, status, notes, created_by, confirmed_at
           ) VALUES ($1,$2,$3,$4,$5,$6::date,$6::date,$7,$8,COALESCE($9,'confirmed'),$10,$11,NOW())`,
          [
            organizationId,
            employeeId,
            template.slot_id,
            template.location_id,
            template.temporary_role_id,
            targetDate,
            template.start_time,
            template.end_time,
            template.status === 'cancelled' ? 'confirmed' : template.status,
            template.notes,
            createdBy,
          ],
        );
        dayInserted += 1;
        insertedCount += 1;
      }
      if (dayInserted > 0) daysFilled += 1;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      ok: true,
      month_start: monthStart,
      month_end: monthEnd,
      fill_from: fillFrom,
      pattern_start: patternStart,
      pattern_end: patternEnd,
      days_filled: daysFilled,
      inserted_count: insertedCount,
      skipped_count: skippedCount,
    };
  }

  async acknowledgeToday(_organizationId: string, _userId: string) {
    // Placeholder for schedule acknowledgement parity.
    return { ok: true };
  }
}
