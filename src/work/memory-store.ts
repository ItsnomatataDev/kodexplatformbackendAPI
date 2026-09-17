import { randomUUID } from 'node:crypto';
import type {
  BoardRecord,
  CreateBoardInput,
  CreateColumnInput,
  ColumnRecord,
  UpdateBoardInput,
  UpdateColumnInput,
  WorkStore,
} from './store.js';

export class MemoryBoardStore implements WorkStore {
  private readonly boards = new Map<string, BoardRecord>();
  private readonly columns = new Map<string, ColumnRecord>();

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
}
