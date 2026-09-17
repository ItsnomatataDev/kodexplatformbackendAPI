export type BoardRecord = {
  id: string;
  organizationId: string;
  createdBy: string;
  ownerId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  status: string;
  color: string | null;
  position: number;
  metadata: unknown;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateBoardInput = {
  organizationId: string;
  createdBy: string;
  ownerId?: string | null;
  name: string;
  slug?: string | null;
  description?: string | null;
  status?: string;
  color?: string | null;
  position?: number;
  metadata?: Record<string, unknown>;
};

export type UpdateBoardInput = {
  name?: string;
  slug?: string | null;
  description?: string | null;
  status?: string;
  color?: string | null;
  position?: number;
  metadata?: Record<string, unknown>;
  ownerId?: string | null;
};

export interface BoardStore {
  listByOrganization(organizationId: string): Promise<BoardRecord[]>;
  getById(
    organizationId: string,
    boardId: string,
  ): Promise<BoardRecord | null>;
  create(input: CreateBoardInput): Promise<BoardRecord>;
  update(
    organizationId: string,
    boardId: string,
    input: UpdateBoardInput,
  ): Promise<BoardRecord | null>;
}

export type ColumnRecord = {
  id: string;
  organizationId: string;
  boardId: string;
  name: string;
  color: string | null;
  statusKey: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateColumnInput = {
  organizationId: string;
  boardId: string;
  name: string;
  color?: string | null;
  statusKey?: string | null;
  position?: number;
};

export type UpdateColumnInput = {
  name?: string;
  color?: string | null;
  statusKey?: string | null;
  position?: number;
};

export interface ColumnStore {
  listColumnsByBoard(
    organizationId: string,
    boardId: string,
  ): Promise<ColumnRecord[]>;
  getColumnById(
    organizationId: string,
    columnId: string,
  ): Promise<ColumnRecord | null>;
  createColumn(input: CreateColumnInput): Promise<ColumnRecord | null>;
  updateColumn(
    organizationId: string,
    columnId: string,
    input: UpdateColumnInput,
  ): Promise<ColumnRecord | null>;
}

export type WorkStore = BoardStore & ColumnStore;
