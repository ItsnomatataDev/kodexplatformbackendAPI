export function hasPermission(
  permissions: unknown,
  action: string,
): boolean {
  if (permissions === true) {
    return true;
  }

  if (typeof permissions !== 'object' || permissions === null) {
    return false;
  }

  if (Array.isArray(permissions)) {
    return permissions.includes(action) || permissions.includes('*');
  }

  const record = permissions as Record<string, unknown>;

  if (record[action] === true || record['*'] === true) {
    return true;
  }

  const segments = action.split('.');
  let current: unknown = record;

  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return false;
    }

    const node = current as Record<string, unknown>;

    if (node['*'] === true) {
      return true;
    }

    current = node[segment];
  }

  return current === true;
}
