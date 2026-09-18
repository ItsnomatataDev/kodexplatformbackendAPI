import { db } from '../db/pool.js';
import { ConflictError } from '../http/errors.js';
import { optionalText } from '../http/fields.js';
import { FIELD_LIMITS } from '../http/limits.js';

export type PublicProfile = {
  fullName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
  employeeCode: string | null;
  username: string | null;
};

export type PublicProfilePatch = {
  fullName?: string | null;
  avatarUrl?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  username?: string | null;
};

type ProfileRow = {
  full_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  department: string | null;
  employee_code: string | null;
  username: string | null;
};

const REJECTED_PROFILE_FIELDS = [
  'organizationId',
  'organization_id',
  'organization',
  'roleKey',
  'role_key',
  'roleId',
  'role_id',
  'role',
  'officeId',
  'office_id',
  'office',
  'isAdminRole',
  'is_admin_role',
  'isManagerRole',
  'is_manager_role',
  'accountStatus',
  'account_status',
  'permissions',
  'membershipId',
  'membership_id',
] as const;

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === '23505',
  );
}

function serializeProfile(row: ProfileRow): PublicProfile {
  return {
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    department: row.department,
    employeeCode: row.employee_code,
    username: row.username,
  };
}

export function rejectedProfileFields(body: Record<string, unknown>) {
  return REJECTED_PROFILE_FIELDS.filter((field) => field in body);
}

export function readPublicProfilePatch(
  body: Record<string, unknown>,
): PublicProfilePatch {
  return {
    fullName: optionalText(body.fullName, 'fullName', FIELD_LIMITS.profileFullName),
    avatarUrl: optionalText(
      body.avatarUrl,
      'avatarUrl',
      FIELD_LIMITS.profileAvatarUrl,
    ),
    jobTitle: optionalText(body.jobTitle, 'jobTitle', FIELD_LIMITS.profileJobTitle),
    department: optionalText(
      body.department,
      'department',
      FIELD_LIMITS.profileDepartment,
    ),
    username: optionalText(body.username, 'username', FIELD_LIMITS.profileUsername),
  };
}

export async function loadPublicProfile(
  userId: string,
): Promise<PublicProfile | null> {
  const result = await db.query<ProfileRow>(
    `
      SELECT
        full_name,
        avatar_url,
        job_title,
        department,
        employee_code,
        username
      FROM identity.user_profiles
      WHERE user_id = $1
    `,
    [userId],
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return serializeProfile(row);
}

export async function updatePublicProfile(
  userId: string,
  patch: PublicProfilePatch,
): Promise<PublicProfile> {
  const assignments: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let index = 1;

  if (patch.fullName !== undefined) {
    assignments.push(`full_name = $${index++}`);
    values.push(patch.fullName);
  }

  if (patch.avatarUrl !== undefined) {
    assignments.push(`avatar_url = $${index++}`);
    values.push(patch.avatarUrl);
  }

  if (patch.jobTitle !== undefined) {
    assignments.push(`job_title = $${index++}`);
    values.push(patch.jobTitle);
  }

  if (patch.department !== undefined) {
    assignments.push(`department = $${index++}`);
    values.push(patch.department);
  }

  if (patch.username !== undefined) {
    assignments.push(`username = $${index++}`);
    values.push(patch.username);
  }

  values.push(userId);

  try {
    const updated = await db.query<ProfileRow>(
      `
        UPDATE identity.user_profiles
        SET ${assignments.join(', ')}
        WHERE user_id = $${index}
        RETURNING
          full_name,
          avatar_url,
          job_title,
          department,
          employee_code,
          username
      `,
      values,
    );

    if (updated.rows[0]) {
      return serializeProfile(updated.rows[0]);
    }

    const inserted = await db.query<ProfileRow>(
      `
        INSERT INTO identity.user_profiles (
          user_id,
          full_name,
          avatar_url,
          job_title,
          department,
          username
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING
          full_name,
          avatar_url,
          job_title,
          department,
          employee_code,
          username
      `,
      [
        userId,
        patch.fullName ?? null,
        patch.avatarUrl ?? null,
        patch.jobTitle ?? null,
        patch.department ?? null,
        patch.username ?? null,
      ],
    );

    return serializeProfile(inserted.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'USERNAME_TAKEN',
        'That username is already in use.',
      );
    }

    throw error;
  }
}
