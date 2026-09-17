import { db } from '../db/pool.js';
import type {
  BoardRecord,
  CreateBoardInput,
  CreateColumnInput,
  ColumnRecord,
  UpdateBoardInput,
  UpdateColumnInput,
  WorkStore,
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

type ColumnRow = {
  id: string;
  organization_id: string;
  board_id: string;
  name: string;
  color: string | null;
  status_key: string | null;
  position: number;
  created_at: Date;
  updated_at: Date;
};

const COLUMN_COLUMNS = `
  id,
  organization_id,
  board_id,
  name,
  color,
  status_key,
  position,
  created_at,
  updated_at
`;

function mapColumn(row: ColumnRow): ColumnRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    boardId: row.board_id,
    name: row.name,
    color: row.color,
    statusKey: row.status_key,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresBoardStore implements WorkStore {
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

  async listColumnsByBoard(organizationId: string, boardId: string) {
    const result = await db.query<ColumnRow>(
      `
        SELECT ${COLUMN_COLUMNS}
        FROM work.board_columns
        WHERE organization_id = $1
          AND board_id = $2
        ORDER BY position ASC, created_at ASC, id ASC
      `,
      [organizationId, boardId],
    );

    return result.rows.map(mapColumn);
  }

  async getColumnById(organizationId: string, columnId: string) {
    const result = await db.query<ColumnRow>(
      `
        SELECT
          c.id,
          c.organization_id,
          c.board_id,
          c.name,
          c.color,
          c.status_key,
          c.position,
          c.created_at,
          c.updated_at
        FROM work.board_columns c
        JOIN work.boards b
          ON b.id = c.board_id
         AND b.organization_id = c.organization_id
        WHERE c.organization_id = $1
          AND c.id = $2
      `,
      [organizationId, columnId],
    );

    return result.rows[0] ? mapColumn(result.rows[0]) : null;
  }

  async createColumn(input: CreateColumnInput) {
    const result = await db.query<ColumnRow>(
      `
        INSERT INTO work.board_columns (
          id,
          organization_id,
          board_id,
          name,
          color,
          status_key,
          position,
          created_at,
          updated_at,
          legacy_source,
          legacy_id
        )
        SELECT
          gen_random_uuid(),
          b.organization_id,
          b.id,
          $3,
          $4,
          $5,
          $6,
          NOW(),
          NOW(),
          'kode-platform',
          gen_random_uuid()
        FROM work.boards b
        WHERE b.organization_id = $1
          AND b.id = $2
        RETURNING ${COLUMN_COLUMNS}
      `,
      [
        input.organizationId,
        input.boardId,
        input.name,
        input.color ?? null,
        input.statusKey ?? null,
        input.position ?? 0,
      ],
    );

    return result.rows[0] ? mapColumn(result.rows[0]) : null;
  }

  async updateColumn(
    organizationId: string,
    columnId: string,
    input: UpdateColumnInput,
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
    if (input.color !== undefined) assign('color', input.color);
    if (input.statusKey !== undefined) assign('status_key', input.statusKey);
    if (input.position !== undefined) assign('position', input.position);

    values.push(organizationId, columnId);

    const result = await db.query<ColumnRow>(
      `
        UPDATE work.board_columns c
        SET ${sets.join(', ')}
        FROM work.boards b
        WHERE c.organization_id = $${index}
          AND c.id = $${index + 1}
          AND b.id = c.board_id
          AND b.organization_id = c.organization_id
        RETURNING
          c.id,
          c.organization_id,
          c.board_id,
          c.name,
          c.color,
          c.status_key,
          c.position,
          c.created_at,
          c.updated_at
      `,
      values,
    );

    return result.rows[0] ? mapColumn(result.rows[0]) : null;
  }
}
