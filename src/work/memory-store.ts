import { randomUUID } from 'node:crypto';
import type {
  BoardRecord,
  BoardStore,
  CreateBoardInput,
  UpdateBoardInput,
} from './store.js';

export class MemoryBoardStore implements BoardStore {
  private readonly boards = new Map<string, BoardRecord>();

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
}
