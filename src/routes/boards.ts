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
import type { BoardRecord, BoardStore, UpdateBoardInput } from '../work/store.js';

export type BoardRouteDependencies = {
  store: BoardStore;
};

function serializeBoard(board: BoardRecord) {
  return {
    id: board.id,
    organizationId: board.organizationId,
    createdBy: board.createdBy,
    ownerId: board.ownerId,
    name: board.name,
    slug: board.slug,
    description: board.description,
    status: board.status,
    color: board.color,
    position: board.position,
    metadata: board.metadata,
    archivedAt: board.archivedAt?.toISOString() ?? null,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
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

function readOptionalMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('Metadata must be a JSON object.');
  }

  return value as Record<string, unknown>;
}

function requireBoardId(boardId: string | undefined): string {
  if (!boardId || !isUuid(boardId)) {
    throw new ValidationError('boardId must be a UUID.');
  }

  return boardId;
}

function rejectIdentityOverrides(
  auth: ReturnType<typeof getAuth>,
  c: { req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined } },
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

export function createBoardRoutes(dependencies: BoardRouteDependencies) {
  const boards = new Hono();

  boards.get('/', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);

    assertAuthorized({
      context: auth,
      action: 'work.boards.read',
      resource: {
        type: 'work.board',
        organizationId,
      },
    });

    const records = await dependencies.store.listByOrganization(organizationId);
    return c.json({
      boards: records.map(serializeBoard),
    });
  });

  boards.post('/', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const organizationId = requireOrganizationId(auth);

    assertAuthorized({
      context: auth,
      action: 'work.boards.create',
      resource: {
        type: 'work.board',
        organizationId,
      },
    });

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new ValidationError('Board name is required.', { field: 'name' });
    }

    const ownerId = readOptionalString(body.ownerId ?? body.owner_id);
    if (ownerId && !isUuid(ownerId)) {
      throw new ValidationError('ownerId must be a UUID.');
    }

    const board = await dependencies.store.create({
      organizationId,
      createdBy: auth.actor.userId,
      ownerId: ownerId ?? null,
      name: body.name.trim(),
      slug: readOptionalString(body.slug) ?? null,
      description: readOptionalString(body.description) ?? null,
      status: readOptionalString(body.status) ?? 'active',
      color: readOptionalString(body.color) ?? null,
      position: readOptionalInteger(body.position) ?? 0,
      metadata: readOptionalMetadata(body.metadata) ?? {},
    });

    return c.json({ board: serializeBoard(board) }, 201);
  });

  boards.get('/:boardId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const boardId = requireBoardId(c.req.param('boardId'));

    assertAuthorized({
      context: auth,
      action: 'work.boards.read',
      resource: {
        type: 'work.board',
        id: boardId,
        organizationId,
      },
    });

    const board = await dependencies.store.getById(organizationId, boardId);

    if (!board) {
      throw new NotFoundError('BOARD_NOT_FOUND', 'The board was not found.');
    }

    return c.json({ board: serializeBoard(board) });
  });

  boards.patch('/:boardId', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const organizationId = requireOrganizationId(auth);
    const boardId = requireBoardId(c.req.param('boardId'));

    assertAuthorized({
      context: auth,
      action: 'work.boards.update',
      resource: {
        type: 'work.board',
        id: boardId,
        organizationId,
      },
    });

    const patch: UpdateBoardInput = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new ValidationError('Board name is required.', { field: 'name' });
      }
      patch.name = body.name.trim();
    }

    if (body.slug !== undefined) patch.slug = readOptionalString(body.slug) ?? null;
    if (body.description !== undefined) {
      patch.description = readOptionalString(body.description) ?? null;
    }
    if (body.status !== undefined) {
      patch.status = readOptionalString(body.status) ?? 'active';
    }
    if (body.color !== undefined) patch.color = readOptionalString(body.color) ?? null;
    if (body.position !== undefined) patch.position = readOptionalInteger(body.position);
    if (body.metadata !== undefined) patch.metadata = readOptionalMetadata(body.metadata);
    if (body.ownerId !== undefined || body.owner_id !== undefined) {
      const ownerId = readOptionalString(body.ownerId ?? body.owner_id);
      if (ownerId && !isUuid(ownerId)) {
        throw new ValidationError('ownerId must be a UUID.');
      }
      patch.ownerId = ownerId ?? null;
    }

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No board fields were provided to update.');
    }

    const board = await dependencies.store.update(
      organizationId,
      boardId,
      patch,
    );

    if (!board) {
      throw new NotFoundError('BOARD_NOT_FOUND', 'The board was not found.');
    }

    return c.json({ board: serializeBoard(board) });
  });

  return boards;
}
