import { db } from '../db/pool.js';
import type { NavigationMatch } from './navigation.js';

function likePattern(query: string) {
  return `%${query.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function boundedLimit(limit: number) {
  if (!Number.isFinite(limit)) return 8;
  return Math.min(Math.max(Math.floor(limit), 1), 8);
}

export async function searchContentClients(
  organizationId: string,
  officeId: string | null,
  query: string,
  limit = 8,
): Promise<NavigationMatch[]> {
  const needle = query.trim();
  if (needle.length < 2 || !officeId) return [];
  const result = await db.query<{ id: string; company_name: string }>(
    `
      SELECT id, company_name
      FROM content.clients
      WHERE organization_id = $1
        AND office_id = $2
        AND is_active = TRUE
        AND company_name ILIKE $3 ESCAPE '\\'
      ORDER BY (lower(company_name) = lower($5)) DESC, company_name ASC, id ASC
      LIMIT $4
    `,
    [organizationId, officeId, likePattern(needle), boundedLimit(limit), needle],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.company_name }));
}

export async function searchBoards(
  organizationId: string,
  query: string,
  limit = 8,
): Promise<NavigationMatch[]> {
  const needle = query.trim();
  if (needle.length < 2) return [];
  const result = await db.query<{ id: string; name: string }>(
    `
      SELECT id, name
      FROM work.boards
      WHERE organization_id = $1
        AND archived_at IS NULL
        AND name ILIKE $2 ESCAPE '\\'
      ORDER BY (lower(name) = lower($4)) DESC, name ASC, id ASC
      LIMIT $3
    `,
    [organizationId, likePattern(needle), boundedLimit(limit), needle],
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name }));
}
