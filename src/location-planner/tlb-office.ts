const TLB_SLUGS = new Set(['three-little-birds', 'tlb']);

export function normalizeOfficeSlug(value: string | null | undefined) {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-');
}

export function isThreeLittleBirdsOffice(
  slug: string | null | undefined,
  name?: string | null,
) {
  const normalized = normalizeOfficeSlug(slug);
  if (TLB_SLUGS.has(normalized) || normalized.includes('little-bird')) {
    return true;
  }
  const label = (name ?? '').trim().toLowerCase();
  return label.includes('three little bird') || label.includes('little bird');
}

export function isLocationPlannerAdminRole(
  roleKey: string | null | undefined,
  isAdminRole?: boolean | null,
) {
  if (isAdminRole) return true;
  const key = (roleKey ?? '').trim().toLowerCase();
  return key === 'admin' || key === 'org_admin' || key === 'super_admin' || key === 'superadmin';
}
