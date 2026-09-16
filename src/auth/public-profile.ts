import { db } from '../db/pool.js';

export type PublicProfile = {
  fullName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  department: string | null;
  employeeCode: string | null;
  username: string | null;
};

type ProfileRow = {
  full_name: string | null;
  avatar_url: string | null;
  job_title: string | null;
  department: string | null;
  employee_code: string | null;
  username: string | null;
};

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

  return {
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    department: row.department,
    employeeCode: row.employee_code,
    username: row.username,
  };
}
