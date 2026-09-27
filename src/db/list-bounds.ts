/** Newest rows returned by an organization list when the caller does not ask for less. */
export const ORGANIZATION_LIST_LIMIT = 200;

/** Furthest offset a name-ordered list will scan. */
export const ORGANIZATION_LIST_MAX_OFFSET = 10_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function listOffset(
  requested?: number,
  max = ORGANIZATION_LIST_MAX_OFFSET,
) {
  if (requested == null || !Number.isFinite(requested)) return 0;
  const whole = Math.floor(requested);
  if (whole < 1) return 0;
  return Math.min(whole, max);
}

export function listLimit(requested?: number, max = ORGANIZATION_LIST_LIMIT) {
  if (requested == null || !Number.isFinite(requested)) {
    return max;
  }
  const whole = Math.floor(requested);
  if (whole < 1) return 1;
  return Math.min(whole, max);
}

export type ListPage<T> = {
  rows: T[];
  hasMore: boolean;
};

/** Drop the extra probe row fetched with LIMIT n+1. */
export function pageOf<T>(rows: T[], limit: number): ListPage<T> {
  const bounded = listLimit(limit);
  return {
    rows: rows.slice(0, bounded),
    hasMore: rows.length > bounded,
  };
}

export type ListQuery = {
  limit: number;
  before?: string;
  beforeId?: string;
};

export function parseListQuery(input: {
  limit?: string | null;
  before?: string | null;
  beforeId?: string | null;
}): { ok: true; query: ListQuery } | { ok: false } {
  const before = input.before?.trim() || undefined;
  const beforeId = input.beforeId?.trim() || undefined;
  if (Boolean(before) !== Boolean(beforeId)) return { ok: false };
  if (before && Number.isNaN(Date.parse(before))) return { ok: false };
  if (beforeId && !UUID_PATTERN.test(beforeId)) return { ok: false };
  const raw =
    input.limit == null || input.limit.trim() === ''
      ? undefined
      : Number(input.limit);
  return { ok: true, query: { limit: listLimit(raw), before, beforeId } };
}

/**
 * Keyset predicate. Column names must be fixed SQL identifiers, never request text.
 */
export function keysetPredicate(
  params: unknown[],
  cursor: { at?: string; id?: string } | undefined,
  createdSql: string,
  idSql: string,
  direction: 'asc' | 'desc' = 'desc',
) {
  if (!cursor?.at || !cursor.id) return '';
  params.push(cursor.at, cursor.id);
  const operator = direction === 'desc' ? '<' : '>';
  return ` AND (${createdSql}, ${idSql}) ${operator} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
}
