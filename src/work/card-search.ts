import { db } from '../db/pool.js';

export type ActiveCardMatch = {
  id: string;
  title: string;
  boardName: string | null;
};

function boundedLimit(limit: number) {
  if (!Number.isFinite(limit)) return 8;
  return Math.min(Math.max(Math.floor(limit), 1), 8);
}

export async function searchActiveCards(organizationId: string, query: string, limit = 8) {
  const needle = query.trim();
  if (needle.length < 2) return [];
  const escaped = needle.replace(/[\\%_]/g, (character) => `\\${character}`);
  const result = await db.query<{ id: string; title: string; board_name: string | null }>(
    `
      SELECT card.id, card.title, board.name AS board_name
      FROM work.cards card
      JOIN work.boards board
        ON board.id = card.board_id
       AND board.organization_id = card.organization_id
      WHERE card.organization_id = $1
        AND card.archived_at IS NULL
        AND board.archived_at IS NULL
        AND card.title ILIKE $2 ESCAPE '\\'
      ORDER BY (lower(card.title) = lower($4)) DESC, card.updated_at DESC, card.id ASC
      LIMIT $3
    `,
    [organizationId, `%${escaped}%`, boundedLimit(limit), needle],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    boardName: row.board_name,
  }));
}
