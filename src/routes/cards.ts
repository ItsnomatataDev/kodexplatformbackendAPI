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
import type { CardRecord, UpdateCardInput, WorkStore } from '../work/store.js';

export type CardRouteDependencies = {
  store: WorkStore;
};

function serializeCard(card: CardRecord) {
  return {
    id: card.id,
    organizationId: card.organizationId,
    boardId: card.boardId,
    columnId: card.columnId,
    title: card.title,
    description: card.description,
    statusKey: card.statusKey,
    priority: card.priority,
    department: card.department,
    dueAt: card.dueAt?.toISOString() ?? null,
    startAt: card.startAt?.toISOString() ?? null,
    completedAt: card.completedAt?.toISOString() ?? null,
    blockedReason: card.blockedReason,
    aiGenerated: card.aiGenerated,
    position: card.position,
    metadata: card.metadata,
    trackedSecondsCache: card.trackedSecondsCache,
    isBillable: card.isBillable,
    estimatedSeconds: card.estimatedSeconds,
    archivedAt: card.archivedAt?.toISOString() ?? null,
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
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

function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required.`, { field });
  }

  return value.trim();
}

function readOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer.`);
  }

  return value;
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean.`);
  }

  return value;
}

function readOptionalTimestamp(
  value: unknown,
  field: string,
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO 8601 timestamp.`);
  }

  return new Date(value);
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

function requireId(value: string | undefined, field: string): string {
  if (!value || !isUuid(value)) {
    throw new ValidationError(`${field} must be a UUID.`);
  }

  return value;
}

function requireColumnId(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new ValidationError('columnId must be a UUID.', { field: 'columnId' });
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
  const identityCandidates = [
    c.req.query('user_id'),
    c.req.header('x-user-id'),
    body.createdBy,
    body.created_by,
    body.assignedTo,
    body.assigned_to,
    body.assignedBy,
    body.assigned_by,
    body.archivedBy,
    body.archived_by,
  ];

  for (const candidate of identityCandidates) {
    rejectClientUserOverride(
      auth,
      typeof candidate === 'string' ? candidate : null,
    );
  }

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

async function requireColumnOnBoard(
  store: WorkStore,
  organizationId: string,
  boardId: string,
  columnId: string,
) {
  const column = await store.getColumnById(organizationId, columnId);

  if (!column) {
    throw new NotFoundError('COLUMN_NOT_FOUND', 'The column was not found.');
  }

  if (column.boardId !== boardId) {
    throw new ValidationError('columnId must belong to the board.', {
      field: 'columnId',
    });
  }

  return column;
}

export function createBoardCardRoutes(dependencies: CardRouteDependencies) {
  const routes = new Hono();

  routes.get('/:boardId/cards', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const boardId = requireId(c.req.param('boardId'), 'boardId');

    assertAuthorized({
      context: auth,
      action: 'work.cards.read',
      resource: {
        type: 'work.card',
        organizationId,
        id: boardId,
      },
    });

    await requireBoardInOrganization(dependencies.store, organizationId, boardId);
    const cards = await dependencies.store.listCardsByBoard(
      organizationId,
      boardId,
    );

    return c.json({
      cards: cards.map(serializeCard),
    });
  });

  routes.post('/:boardId/cards', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const organizationId = requireOrganizationId(auth);
    const boardId = requireId(c.req.param('boardId'), 'boardId');

    assertAuthorized({
      context: auth,
      action: 'work.cards.create',
      resource: {
        type: 'work.card',
        organizationId,
        id: boardId,
      },
    });

    if (body.boardId !== undefined || body.board_id !== undefined) {
      const requestedBoardId = body.boardId ?? body.board_id;
      if (requestedBoardId !== boardId) {
        throw new ValidationError('boardId cannot be changed.');
      }
    }

    const title = readRequiredText(body.title, 'title');
    const columnId = requireColumnId(body.columnId ?? body.column_id);
    const statusKey = readOptionalString(body.statusKey ?? body.status_key);
    const priority = readOptionalString(body.priority);

    if (body.statusKey !== undefined || body.status_key !== undefined) {
      if (!statusKey) {
        throw new ValidationError('statusKey is required.', {
          field: 'statusKey',
        });
      }
    }

    if (body.priority !== undefined && !priority) {
      throw new ValidationError('priority is required.', { field: 'priority' });
    }

    await requireBoardInOrganization(dependencies.store, organizationId, boardId);
    await requireColumnOnBoard(
      dependencies.store,
      organizationId,
      boardId,
      columnId,
    );

    const card = await dependencies.store.createCard({
      organizationId,
      boardId,
      columnId,
      createdBy: auth.actor.userId,
      title,
      description: readOptionalString(body.description) ?? null,
      statusKey: statusKey ?? undefined,
      priority: priority ?? undefined,
      department: readOptionalString(body.department) ?? null,
      dueAt: readOptionalTimestamp(body.dueAt ?? body.due_at, 'dueAt') ?? null,
      startAt:
        readOptionalTimestamp(body.startAt ?? body.start_at, 'startAt') ?? null,
      position: readOptionalInteger(body.position, 'Position'),
      isBillable: readOptionalBoolean(
        body.isBillable ?? body.is_billable,
        'isBillable',
      ),
      estimatedSeconds: readOptionalInteger(
        body.estimatedSeconds ?? body.estimated_seconds,
        'estimatedSeconds',
      ),
      metadata: readOptionalMetadata(body.metadata) ?? {},
    });

    if (!card) {
      throw new NotFoundError('BOARD_NOT_FOUND', 'The board was not found.');
    }

    return c.json({ card: serializeCard(card) }, 201);
  });

  return routes;
}

export function createCardRoutes(dependencies: CardRouteDependencies) {
  const routes = new Hono();

  routes.get('/:cardId', async (c) => {
    const auth = getAuth(c);
    rejectIdentityOverrides(auth, c);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');

    assertAuthorized({
      context: auth,
      action: 'work.cards.read',
      resource: {
        type: 'work.card',
        id: cardId,
        organizationId,
      },
    });

    const card = await dependencies.store.getCardById(organizationId, cardId);

    if (!card) {
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }

    return c.json({ card: serializeCard(card) });
  });

  routes.patch('/:cardId', async (c) => {
    const auth = getAuth(c);
    const body = await readJson(c);
    rejectIdentityOverrides(auth, c, body);
    const organizationId = requireOrganizationId(auth);
    const cardId = requireId(c.req.param('cardId'), 'cardId');

    if (body.boardId !== undefined || body.board_id !== undefined) {
      throw new ValidationError('boardId cannot be changed.');
    }

    const existing = await dependencies.store.getCardById(
      organizationId,
      cardId,
    );

    if (!existing) {
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }

    assertAuthorized({
      context: auth,
      action: 'work.cards.update',
      resource: {
        type: 'work.card',
        id: cardId,
        organizationId,
      },
    });

    const patch: UpdateCardInput = {};

    if (body.title !== undefined) {
      patch.title = readRequiredText(body.title, 'title');
    }

    if (body.description !== undefined) {
      patch.description = readOptionalString(body.description) ?? null;
    }

    if (body.columnId !== undefined || body.column_id !== undefined) {
      const columnId = requireColumnId(body.columnId ?? body.column_id);
      await requireColumnOnBoard(
        dependencies.store,
        organizationId,
        existing.boardId,
        columnId,
      );
      patch.columnId = columnId;
    }

    if (body.statusKey !== undefined || body.status_key !== undefined) {
      const statusKey = readOptionalString(body.statusKey ?? body.status_key);
      if (!statusKey) {
        throw new ValidationError('statusKey is required.', {
          field: 'statusKey',
        });
      }
      patch.statusKey = statusKey;
    }

    if (body.priority !== undefined) {
      const priority = readOptionalString(body.priority);
      if (!priority) {
        throw new ValidationError('priority is required.', { field: 'priority' });
      }
      patch.priority = priority;
    }

    if (body.department !== undefined) {
      patch.department = readOptionalString(body.department) ?? null;
    }

    if (body.dueAt !== undefined || body.due_at !== undefined) {
      patch.dueAt =
        readOptionalTimestamp(body.dueAt ?? body.due_at, 'dueAt') ?? null;
    }

    if (body.startAt !== undefined || body.start_at !== undefined) {
      patch.startAt =
        readOptionalTimestamp(body.startAt ?? body.start_at, 'startAt') ?? null;
    }

    if (body.completedAt !== undefined || body.completed_at !== undefined) {
      patch.completedAt =
        readOptionalTimestamp(
          body.completedAt ?? body.completed_at,
          'completedAt',
        ) ?? null;
    }

    if (body.blockedReason !== undefined || body.blocked_reason !== undefined) {
      patch.blockedReason =
        readOptionalString(body.blockedReason ?? body.blocked_reason) ?? null;
    }

    if (body.position !== undefined) {
      patch.position = readOptionalInteger(body.position, 'Position');
    }

    if (body.isBillable !== undefined || body.is_billable !== undefined) {
      patch.isBillable = readOptionalBoolean(
        body.isBillable ?? body.is_billable,
        'isBillable',
      );
    }

    if (
      body.estimatedSeconds !== undefined ||
      body.estimated_seconds !== undefined
    ) {
      patch.estimatedSeconds = readOptionalInteger(
        body.estimatedSeconds ?? body.estimated_seconds,
        'estimatedSeconds',
      );
    }

    if (body.metadata !== undefined) {
      patch.metadata = readOptionalMetadata(body.metadata);
    }

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No card fields were provided to update.');
    }

    const card = await dependencies.store.updateCard(
      organizationId,
      cardId,
      patch,
    );

    if (!card) {
      throw new NotFoundError('CARD_NOT_FOUND', 'The card was not found.');
    }

    return c.json({ card: serializeCard(card) });
  });

  return routes;
}
