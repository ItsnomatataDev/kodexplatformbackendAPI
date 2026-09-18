export const KODE_OPERATING_ROLE_KEYS = [
  'admin',
  'manager',
  'it',
  'media_team',
  'social_media',
  'seo_specialist',
] as const;

export const KODE_LEGACY_ROLE_KEYS = [
  'activity_coordinator',
  'driver',
  'employee',
  'finance',
  'fleet_coordinator',
  'guest_relations',
  'reservations_agent',
  'tour_guide',
  'tourism_operations_manager',
] as const;

export type KodeOperatingRoleKey = (typeof KODE_OPERATING_ROLE_KEYS)[number];
export type KodeLegacyRoleKey = (typeof KODE_LEGACY_ROLE_KEYS)[number];

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export function isKodeOperatingRoleKey(
  roleKey: string,
): roleKey is KodeOperatingRoleKey {
  return (KODE_OPERATING_ROLE_KEYS as readonly string[]).includes(roleKey);
}

export function isKodeLegacyRoleKey(
  roleKey: string,
): roleKey is KodeLegacyRoleKey {
  return (KODE_LEGACY_ROLE_KEYS as readonly string[]).includes(roleKey);
}

export async function applyKodeRoleModel(client: Queryable): Promise<void> {
  await client.query(
    `
      UPDATE organizations.roles
      SET
        is_active = TRUE,
        updated_at = NOW()
      WHERE role_key = ANY($1::text[])
    `,
    [KODE_OPERATING_ROLE_KEYS],
  );

  await client.query(
    `
      UPDATE organizations.roles
      SET
        is_active = FALSE,
        is_default_signup_role = FALSE,
        updated_at = NOW()
      WHERE role_key = ANY($1::text[])
    `,
    [KODE_LEGACY_ROLE_KEYS],
  );
}
