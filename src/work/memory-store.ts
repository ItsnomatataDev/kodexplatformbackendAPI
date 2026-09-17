import { randomUUID } from 'node:crypto';
import type {
  BoardRecord,
  CardRecord,
  CreateBoardInput,
  CreateCardInput,
  CreateColumnInput,
  ColumnRecord,
  UpdateBoardInput,
  UpdateCardInput,
  UpdateColumnInput,
  WorkStore,
} from './store.js';

export class MemoryBoardStore implements WorkStore {
  private readonly boards = new Map<string, BoardRecord>();
  private readonly columns = new Map<string, ColumnRecord>();
  private readonly cards = new Map<string, CardRecord>();

  async listByOrganization(organizationId: string) {
    return [...this.boards.values()]
      .filter(
        (board) =>
          board.organizationId === organizationId && board.archivedAt == null,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }

        return right.createdAt.getTime() - left.createdAt.getTime();
      })
      .map((board) => ({ ...board }));
  }

  async getById(organizationId: string, boardId: string) {
    const board = this.boards.get(boardId);

    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    return { ...board };
  }

  async create(input: CreateBoardInput) {
    const now = new Date();
    const board: BoardRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      ownerId: input.ownerId ?? null,
      name: input.name,
      slug: input.slug ?? null,
      description: input.description ?? null,
      status: input.status ?? 'active',
      color: input.color ?? null,
      position: input.position ?? 0,
      metadata: input.metadata ?? {},
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.boards.set(board.id, board);
    return { ...board };
  }

  async update(
    organizationId: string,
    boardId: string,
    input: UpdateBoardInput,
  ) {
    const board = this.boards.get(boardId);

    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    if (input.name !== undefined) board.name = input.name;
    if (input.slug !== undefined) board.slug = input.slug;
    if (input.description !== undefined) board.description = input.description;
    if (input.status !== undefined) board.status = input.status;
    if (input.color !== undefined) board.color = input.color;
    if (input.position !== undefined) board.position = input.position;
    if (input.metadata !== undefined) board.metadata = input.metadata;
    if (input.ownerId !== undefined) board.ownerId = input.ownerId;
    board.updatedAt = new Date();

    return { ...board };
  }

  async listColumnsByBoard(organizationId: string, boardId: string) {
    return [...this.columns.values()]
      .filter(
        (column) =>
          column.organizationId === organizationId &&
          column.boardId === boardId,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }

        return left.createdAt.getTime() - right.createdAt.getTime();
      })
      .map((column) => ({ ...column }));
  }

  async getColumnById(organizationId: string, columnId: string) {
    const column = this.columns.get(columnId);

    if (!column || column.organizationId !== organizationId) {
      return null;
    }

    const board = this.boards.get(column.boardId);
    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    return { ...column };
  }

  async createColumn(input: CreateColumnInput) {
    const board = this.boards.get(input.boardId);

    if (!board || board.organizationId !== input.organizationId) {
      return null;
    }

    const now = new Date();
    const column: ColumnRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      boardId: input.boardId,
      name: input.name,
      color: input.color ?? null,
      statusKey: input.statusKey ?? null,
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    this.columns.set(column.id, column);
    return { ...column };
  }

  async updateColumn(
    organizationId: string,
    columnId: string,
    input: UpdateColumnInput,
  ) {
    const current = await this.getColumnById(organizationId, columnId);

    if (!current) {
      return null;
    }

    const column = this.columns.get(columnId)!;
    if (input.name !== undefined) column.name = input.name;
    if (input.color !== undefined) column.color = input.color;
    if (input.statusKey !== undefined) column.statusKey = input.statusKey;
    if (input.position !== undefined) column.position = input.position;
    column.updatedAt = new Date(
      Math.max(Date.now(), column.updatedAt.getTime() + 1),
    );

    return { ...column };
  }

  async listCardsByBoard(organizationId: string, boardId: string) {
    return [...this.cards.values()]
      .filter(
        (card) =>
          card.organizationId === organizationId && card.boardId === boardId,
      )
      .sort((left, right) => {
        if (left.position !== right.position) {
          return left.position - right.position;
        }

        const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
        if (createdDelta !== 0) {
          return createdDelta;
        }

        return left.id.localeCompare(right.id);
      })
      .map((card) => this.cloneCard(card));
  }

  async getCardById(organizationId: string, cardId: string) {
    const card = this.cards.get(cardId);

    if (!card || card.organizationId !== organizationId) {
      return null;
    }

    const board = this.boards.get(card.boardId);
    if (!board || board.organizationId !== organizationId) {
      return null;
    }

    return this.cloneCard(card);
  }

  async createCard(input: CreateCardInput) {
    const board = this.boards.get(input.boardId);

    if (!board || board.organizationId !== input.organizationId) {
      return null;
    }

    const column = this.columns.get(input.columnId);

    if (
      !column ||
      column.organizationId !== input.organizationId ||
      column.boardId !== input.boardId
    ) {
      return null;
    }

    const now = new Date();
    const card: CardRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      boardId: input.boardId,
      columnId: input.columnId,
      title: input.title,
      description: input.description ?? null,
      statusKey: input.statusKey ?? column.statusKey ?? 'todo',
      priority: input.priority ?? 'normal',
      department: input.department ?? null,
      dueAt: input.dueAt ?? null,
      startAt: input.startAt ?? null,
      completedAt: null,
      blockedReason: null,
      aiGenerated: false,
      position:
        input.position ??
        this.nextCardPosition(
          input.organizationId,
          input.boardId,
          input.columnId,
        ),
      metadata: input.metadata ? { ...input.metadata } : {},
      trackedSecondsCache: 0,
      isBillable: input.isBillable ?? false,
      estimatedSeconds: input.estimatedSeconds ?? 0,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.cards.set(card.id, card);
    return this.cloneCard(card);
  }

  async updateCard(
    organizationId: string,
    cardId: string,
    input: UpdateCardInput,
  ) {
    const current = await this.getCardById(organizationId, cardId);

    if (!current) {
      return null;
    }

    if (input.columnId !== undefined) {
      const column = this.columns.get(input.columnId);

      if (
        !column ||
        column.organizationId !== organizationId ||
        column.boardId !== current.boardId
      ) {
        return null;
      }
    }

    const card = this.cards.get(cardId)!;
    if (input.title !== undefined) card.title = input.title;
    if (input.description !== undefined) card.description = input.description;
    if (input.columnId !== undefined) card.columnId = input.columnId;
    if (input.statusKey !== undefined) card.statusKey = input.statusKey;
    if (input.priority !== undefined) card.priority = input.priority;
    if (input.department !== undefined) card.department = input.department;
    if (input.dueAt !== undefined) card.dueAt = input.dueAt;
    if (input.startAt !== undefined) card.startAt = input.startAt;
    if (input.completedAt !== undefined) card.completedAt = input.completedAt;
    if (input.blockedReason !== undefined) card.blockedReason = input.blockedReason;
    if (input.position !== undefined) card.position = input.position;
    if (input.isBillable !== undefined) card.isBillable = input.isBillable;
    if (input.estimatedSeconds !== undefined) {
      card.estimatedSeconds = input.estimatedSeconds;
    }
    if (input.metadata !== undefined) card.metadata = { ...input.metadata };
    card.updatedAt = new Date(
      Math.max(Date.now(), card.updatedAt.getTime() + 1),
    );

    return this.cloneCard(card);
  }

  private nextCardPosition(
    organizationId: string,
    boardId: string,
    columnId: string,
  ) {
    const positions = [...this.cards.values()]
      .filter(
        (card) =>
          card.organizationId === organizationId &&
          card.boardId === boardId &&
          card.columnId === columnId,
      )
      .map((card) => card.position);

    if (positions.length === 0) {
      return 0;
    }

    return Math.max(...positions) + 1;
  }

  private cloneCard(card: CardRecord): CardRecord {
    return {
      ...card,
      metadata:
        card.metadata && typeof card.metadata === 'object'
          ? { ...(card.metadata as Record<string, unknown>) }
          : card.metadata,
    };
  }
}
