import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { rejectClientUserOverride } from '../auth/account.js';
import { isUuid } from '../auth/uuid.js';
import { assertAuthorized } from '../authorization/authorize.js';
import {
  rejectClientOrganizationOverride,
  requireOrganizationId,
} from '../authorization/organization.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import type {
  ColumnRecord,
  UpdateColumnInput,
  WorkStore,
} from '../work/store.js';

export type ColumnRouteDependencies = {
  store: WorkStore;
};

function serializeColumn(column: ColumnRecord) {
  return {
    id: column.id,
    organizationId: column.organizationId,
    boardId: column.boardId,
    name: column.name,
    color: column.color,
    statusKey: column.statusKey,
    position: column.position,
    createdAt: column.createdAt.toISOString(),
    updatedAt: column.updatedAt.toISOString(),
  };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }) {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new ValidationError('Invalid string field.');
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readOptionalInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('Position must be an integer.');
  }

  return value;
}

function requireId(value: string | undefined, field: string): string {
  if (!value || !isUuid(value)) {
    throw new ValidationError(`${field} must be a UUID.`);
  }

  return value;
}

function rejectIdentityOverrides(
  auth: ReturnType<typeof getAuth>,
  c: {
    req: {
      query: (name: string) => string | undefined;
      header: (name: string) => string | undefined;
    };
  },
  body: Record<string, unknown> = {},
) {
  rejectClientUserOverride(
    auth,
    c.req.query('user_id') ??
      c.req.header('x-user-id') ??
      (typeof body.createdBy === 'string' ? body.createdBy : null) ??
      (typeof body.created_by === 'string' ? body.created_by : null),
  );
  rejectClientOrganizationOverride(
    auth,
    c.req.query('organization_id') ??
      c.req.header('x-organization-id') ??
      (typeof body.organizationId === 'string' ? body.organizationId : null) ??
      (typeof body.organization_id === 'string' ? body.organization_id : null),
  );
}

async function requireBoardInOrganization(
  store: WorkStore,
  organizationId: string,
  boardId: string,
) {
  const board = await store.getById(organizationId, boardId);

  if (!board) {
    throw new NotFoundError('BOARD_NOT_FOUND', 'The board was not found.');
  }

  return board;
}

export function createBoardColumnRoutes(dependencies: ColumnRouteDependencies) {
  const routes = new Hono();

  routes.get('/:boardId/columns', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const boardId = requireId(c.req.param('boardId'), 'boardId');

    assertAuthorized({
      context: auth,
      action: 'work.board_columns.read',
      resource: {
        type: 'work.board_column',
        organizationId,
        id: boardId,
      },
    });

    await requireBoardInOrganization(dependencies.store, organizationId, boardId);
    const columns = await dependencies.store.listColumnsByBoard(
      organizationId,
      boardId,
    );

    return c.json({
      columns: columns.map(serializeColumn),
    });
  });

  routes.post('/:boardId/columns', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const organizationId = requireOrganizationId(auth);
    const boardId = requireId(c.req.param('boardId'), 'boardId');

    assertAuthorized({
      context: auth,
      action: 'work.board_columns.create',
      resource: {
        type: 'work.board_column',
        organizationId,
        id: boardId,
      },
    });

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new ValidationError('Column name is required.', { field: 'name' });
    }

    if (body.boardId !== undefined || body.board_id !== undefined) {
      const requestedBoardId = body.boardId ?? body.board_id;
      if (requestedBoardId !== boardId) {
        throw new ValidationError('boardId cannot be changed.');
      }
    }

    await requireBoardInOrganization(dependencies.store, organizationId, boardId);

    const column = await dependencies.store.createColumn({
      organizationId,
      boardId,
      name: body.name.trim(),
      color: readOptionalString(body.color) ?? null,
      statusKey: readOptionalString(body.statusKey ?? body.status_key) ?? null,
      position: readOptionalInteger(body.position) ?? 0,
    });

    if (!column) {
      throw new NotFoundError('BOARD_NOT_FOUND', 'The board was not found.');
    }

    return c.json({ column: serializeColumn(column) }, 201);
  });

  return routes;
}

export function createColumnRoutes(dependencies: ColumnRouteDependencies) {
  const routes = new Hono();

  routes.patch('/:columnId', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const organizationId = requireOrganizationId(auth);
    const columnId = requireId(c.req.param('columnId'), 'columnId');

    if (body.boardId !== undefined || body.board_id !== undefined) {
      throw new ValidationError('boardId cannot be changed.');
    }

    const existing = await dependencies.store.getColumnById(
      organizationId,
      columnId,
    );

    if (!existing) {
      throw new NotFoundError('COLUMN_NOT_FOUND', 'The column was not found.');
    }

    assertAuthorized({
      context: auth,
      action: 'work.board_columns.update',
      resource: {
        type: 'work.board_column',
        id: columnId,
        organizationId,
      },
    });

    const patch: UpdateColumnInput = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new ValidationError('Column name is required.', { field: 'name' });
      }
      patch.name = body.name.trim();
    }

    if (body.color !== undefined) patch.color = readOptionalString(body.color) ?? null;
    if (body.statusKey !== undefined || body.status_key !== undefined) {
      patch.statusKey =
        readOptionalString(body.statusKey ?? body.status_key) ?? null;
    }
    if (body.position !== undefined) {
      patch.position = readOptionalInteger(body.position);
    }

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No column fields were provided to update.');
    }

    const column = await dependencies.store.updateColumn(
      organizationId,
      columnId,
      patch,
    );

    if (!column) {
      throw new NotFoundError('COLUMN_NOT_FOUND', 'The column was not found.');
    }

    return c.json({ column: serializeColumn(column) });
  });

  return routes;
}
