import { db } from '../db/pool.js';
import type {
  BoardRecord,
  BoardStore,
  CreateBoardInput,
  UpdateBoardInput,
} from './store.js';

type BoardRow = {
  id: string;
  organization_id: string;
  created_by: string;
  owner_id: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  status: string;
  color: string | null;
  position: number;
  metadata: unknown;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const BOARD_COLUMNS = `
  id,
  organization_id,
  created_by,
  owner_id,
  name,
  slug,
  description,
  status,
  color,
  position,
  metadata,
  archived_at,
  created_at,
  updated_at
`;

function mapBoard(row: BoardRow): BoardRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    color: row.color,
    position: row.position,
    metadata: row.metadata,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresBoardStore implements BoardStore {
  async listByOrganization(organizationId: string) {
    const result = await db.query<BoardRow>(
      `
        SELECT ${BOARD_COLUMNS}
        FROM work.boards
        WHERE organization_id = $1
          AND archived_at IS NULL
        ORDER BY position ASC, created_at DESC
      `,
      [organizationId],
    );

    return result.rows.map(mapBoard);
  }

  async getById(organizationId: string, boardId: string) {
    const result = await db.query<BoardRow>(
      `
        SELECT ${BOARD_COLUMNS}
        FROM work.boards
        WHERE organization_id = $1
          AND id = $2
      `,
      [organizationId, boardId],
    );

    return result.rows[0] ? mapBoard(result.rows[0]) : null;
  }

  async create(input: CreateBoardInput) {
    const result = await db.query<BoardRow>(
      `
        INSERT INTO work.boards (
          id,
          organization_id,
          created_by,
          owner_id,
          name,
          slug,
          description,
          status,
          color,
          position,
          metadata,
          legacy_source,
          legacy_id
        )
        VALUES (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb,
          'kode-platform',
          gen_random_uuid()
        )
        RETURNING ${BOARD_COLUMNS}
      `,
      [
        input.organizationId,
        input.createdBy,
        input.ownerId ?? null,
        input.name,
        input.slug ?? null,
        input.description ?? null,
        input.status ?? 'active',
        input.color ?? null,
        input.position ?? 0,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return mapBoard(result.rows[0]);
  }

  async update(
    organizationId: string,
    boardId: string,
    input: UpdateBoardInput,
  ) {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let index = 1;

    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = $${index}`);
      values.push(value);
      index += 1;
    };

    if (input.name !== undefined) assign('name', input.name);
    if (input.slug !== undefined) assign('slug', input.slug);
    if (input.description !== undefined) assign('description', input.description);
    if (input.status !== undefined) assign('status', input.status);
    if (input.color !== undefined) assign('color', input.color);
    if (input.position !== undefined) assign('position', input.position);
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${index}::jsonb`);
      values.push(JSON.stringify(input.metadata));
      index += 1;
    }
    if (input.ownerId !== undefined) assign('owner_id', input.ownerId);

    values.push(organizationId, boardId);

    const result = await db.query<BoardRow>(
      `
        UPDATE work.boards
        SET ${sets.join(', ')}
        WHERE organization_id = $${index}
          AND id = $${index + 1}
        RETURNING ${BOARD_COLUMNS}
      `,
      values,
    );

    return result.rows[0] ? mapBoard(result.rows[0]) : null;
  }
}
