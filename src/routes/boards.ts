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
import { optionalMetadata } from '../http/fields.js';
import { FIELD_LIMITS } from '../http/limits.js';
import { rateLimitWork } from '../http/work-rate-limit.js';
import type { BoardRecord, BoardStore, UpdateBoardInput } from '../work/store.js';
import { readJson, readOptionalInteger, readOptionalString, readRequiredText } from '../work/http.js';

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
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);

    assertAuthorized({
      context: auth,
      action: 'work.boards.create',
      resource: {
        type: 'work.board',
        organizationId,
      },
    });
    await rateLimitWork(c, 'mutation');

    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);

    const ownerId = readOptionalString(body.ownerId ?? body.owner_id, 'ownerId', 36);
    if (ownerId && !isUuid(ownerId)) {
      throw new ValidationError('ownerId must be a UUID.');
    }

    const board = await dependencies.store.create({
      organizationId,
      createdBy: auth.actor.userId,
      ownerId: ownerId ?? null,
      name: readRequiredText(body.name, 'name', FIELD_LIMITS.boardName),
      slug: readOptionalString(body.slug, 'slug', FIELD_LIMITS.boardSlug) ?? null,
      description:
        readOptionalString(body.description, 'description', FIELD_LIMITS.boardDescription) ??
        null,
      status: readOptionalString(body.status, 'status', FIELD_LIMITS.boardStatus) ?? 'active',
      color: readOptionalString(body.color, 'color', FIELD_LIMITS.boardColor) ?? null,
      position: readOptionalInteger(body.position, 'position') ?? 0,
      metadata: optionalMetadata(body.metadata) ?? {},
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
    rejectIdentityOverrides(auth, c);
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
    await rateLimitWork(c, 'mutation');

    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);

    const patch: UpdateBoardInput = {};

    if (body.name !== undefined) {
      patch.name = readRequiredText(body.name, 'name', FIELD_LIMITS.boardName);
    }

    if (body.slug !== undefined) {
      patch.slug = readOptionalString(body.slug, 'slug', FIELD_LIMITS.boardSlug) ?? null;
    }
    if (body.description !== undefined) {
      patch.description =
        readOptionalString(body.description, 'description', FIELD_LIMITS.boardDescription) ??
        null;
    }
    if (body.status !== undefined) {
      patch.status =
        readOptionalString(body.status, 'status', FIELD_LIMITS.boardStatus) ?? 'active';
    }
    if (body.color !== undefined) {
      patch.color = readOptionalString(body.color, 'color', FIELD_LIMITS.boardColor) ?? null;
    }
    if (body.position !== undefined) {
      patch.position = readOptionalInteger(body.position, 'position');
    }
    if (body.metadata !== undefined) patch.metadata = optionalMetadata(body.metadata);
    if (body.ownerId !== undefined || body.owner_id !== undefined) {
      const ownerId = readOptionalString(body.ownerId ?? body.owner_id, 'ownerId', 36);
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
