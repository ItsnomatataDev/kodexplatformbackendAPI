/** Shared Supabase REST helpers for live cutover migrations. */

export type JsonRow = Record<string, unknown>;

export function supabaseConfig() {
  const url = (
    process.env.LEGACY_STORAGE_URL ??
    process.env.SUPABASE_URL ??
    'https://zirftywinscopzuuwdlg.supabase.co'
  ).replace(/\/+$/, '');
  const key = (
    process.env.LEGACY_STORAGE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ''
  ).trim();
  if (!key) {
    throw new Error(
      'Set LEGACY_STORAGE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return { url, key };
}

export async function fetchAllRows(
  table: string,
  options: { select?: string; order?: string; pageSize?: number } = {},
): Promise<JsonRow[]> {
  const { url, key } = supabaseConfig();
  const select = options.select ?? '*';
  const order = options.order ?? 'id';
  const pageSize = options.pageSize ?? 1000;
  const rows: JsonRow[] = [];
  let from = 0;

  for (;;) {
    const to = from + pageSize - 1;
    const endpoint = new URL(`${url}/rest/v1/${table}`);
    endpoint.searchParams.set('select', select);
    endpoint.searchParams.set('order', order);

    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        Prefer: 'count=exact',
        Range: `${from}-${to}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Supabase REST ${table} failed (${response.status}): ${body.slice(0, 300)}`,
      );
    }

    const batch = (await response.json()) as JsonRow[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

export function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;
  return fallback;
}

export function asJson(value: unknown, fallback: unknown = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function optionalId(
  value: unknown,
  known: Set<string>,
): string | null {
  const id = asString(value);
  return id && known.has(id) ? id : null;
}
