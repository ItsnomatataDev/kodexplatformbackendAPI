import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { rejectClientUserOverride } from '../auth/account.js';
import { assertAuthorized } from '../authorization/authorize.js';
import {
  rejectClientOrganizationOverride,
  requireOrganizationId,
} from '../authorization/organization.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { FIELD_LIMITS } from '../http/limits.js';
import { rateLimitWork } from '../http/work-rate-limit.js';
import type {
  ColumnRecord,
  UpdateColumnInput,
  WorkStore,
} from '../work/store.js';
import {
  readJson,
  readOptionalInteger,
  readOptionalString,
  readRequiredText,
  requireId,
} from '../work/http.js';

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
    rejectIdentityOverrides(auth, c);
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
    await rateLimitWork(c, 'mutation');

    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);

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
      name: readRequiredText(body.name, 'name', FIELD_LIMITS.columnName),
      color: readOptionalString(body.color, 'color', FIELD_LIMITS.columnColor) ?? null,
      statusKey:
        readOptionalString(
          body.statusKey ?? body.status_key,
          'statusKey',
          FIELD_LIMITS.columnStatusKey,
        ) ?? null,
      position: readOptionalInteger(body.position, 'position') ?? 0,
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
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const columnId = requireId(c.req.param('columnId'), 'columnId');
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);

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
    await rateLimitWork(c, 'mutation');

    const patch: UpdateColumnInput = {};

    if (body.name !== undefined) {
      patch.name = readRequiredText(body.name, 'name', FIELD_LIMITS.columnName);
    }

    if (body.color !== undefined) {
      patch.color = readOptionalString(body.color, 'color', FIELD_LIMITS.columnColor) ?? null;
    }
    if (body.statusKey !== undefined || body.status_key !== undefined) {
      patch.statusKey =
        readOptionalString(
          body.statusKey ?? body.status_key,
          'statusKey',
          FIELD_LIMITS.columnStatusKey,
        ) ?? null;
    }
    if (body.position !== undefined) {
      patch.position = readOptionalInteger(body.position, 'position');
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
