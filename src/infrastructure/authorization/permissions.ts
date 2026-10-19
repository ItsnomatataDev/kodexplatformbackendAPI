export const PERMISSIONS = [
  'infra.dashboard.read',
  'infra.servers.read',
] as const;
export type InfrastructurePermission = (typeof PERMISSIONS)[number];
export const RESERVED_PERMISSIONS = [
  'infra.database.read',
  'infra.database.write',
  'infra.docker.read',
  'infra.docker.manage',
  'infra.terminal.access',
  'infra.files.read',
  'infra.files.write',
  'infra.security.manage',
] as const;
export function validatePermissions(
  input: string[],
): InfrastructurePermission[] {
  if (
    !input.length ||
    input.some((p) => !PERMISSIONS.includes(p as InfrastructurePermission))
  )
    throw new Error('Only explicit Phase 1 permissions may be granted');
  return [...new Set(input)] as InfrastructurePermission[];
}
