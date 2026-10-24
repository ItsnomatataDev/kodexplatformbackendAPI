/** Future design contracts only. No database execution routes or implementations in Phase 1. */
export type ConnectionRef = { serverId: string; connectionId: string };
export type RegisteredPostgresConnection = ConnectionRef & {
  label: string;
  database: string;
  sslRequired: boolean;
  capabilities: ('infra.database.read' | 'infra.database.write')[];
};
export type DatabaseMetadata = { name: string; encoding: string };
export type SchemaMetadata = { name: string };
export type ColumnMetadata = {
  name: string;
  dataType: string;
  nullable: boolean;
  generated: boolean;
  defaultExpression?: string;
};
export type Relationship = {
  name: string;
  columns: string[];
  targetSchema: string;
  targetTable: string;
  targetColumns: string[];
};
export type IndexMetadata = {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
};
export type TableMetadata = {
  schema: string;
  name: string;
  columns: ColumnMetadata[];
  relationships: Relationship[];
  indexes: IndexMetadata[];
};
export type Cell = string | number | boolean | null;
export type Filter = {
  column: string;
  operator: 'eq' | 'lt' | 'gt' | 'is-null';
  value?: Cell;
};
export type BrowseRequest = ConnectionRef & {
  schema: string;
  table: string;
  columns: string[];
  filters: Filter[];
  sort: { column: string; direction: 'asc' | 'desc' }[];
  cursor?: string;
  limit: number;
};
export type BrowsePage = {
  rows: Record<string, Cell>[];
  nextCursor?: string;
  truncated: boolean;
};
export type RowEdit = ConnectionRef & {
  schema: string;
  table: string;
  key: Record<string, Cell>;
  expectedVersion: string;
  values: Record<string, Cell>;
  approvalId: string;
};
export type QueryLimits = {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
  transactionTimeoutMs: number;
};
export type SqlRequest = ConnectionRef & {
  sql: string;
  parameters: Cell[];
  mode: 'read-only' | 'approved-write';
  approvalId?: string;
  limits: QueryLimits;
  requestId: string;
};
export type QueryResult = {
  queryId: string;
  columns: string[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  auditId: string;
};
export type DatabaseOperationContext = {
  infrastructureAccountId: string;
  permission: 'infra.database.read' | 'infra.database.write';
  freshAuthenticationAt: string;
  auditCorrelationId: string;
  signal: AbortSignal;
};
export interface FutureDatabaseService {
  listConnections(
    context: DatabaseOperationContext,
  ): Promise<RegisteredPostgresConnection[]>;
  discoverDatabases(
    ref: ConnectionRef,
    context: DatabaseOperationContext,
  ): Promise<DatabaseMetadata[]>;
  discoverSchemas(
    ref: ConnectionRef,
    context: DatabaseOperationContext,
  ): Promise<SchemaMetadata[]>;
  describeTable(
    ref: ConnectionRef,
    schema: string,
    table: string,
    context: DatabaseOperationContext,
  ): Promise<TableMetadata>;
  browse(
    request: BrowseRequest,
    context: DatabaseOperationContext,
  ): Promise<BrowsePage>;
  edit(
    request: RowEdit,
    context: DatabaseOperationContext,
  ): Promise<{ version: string; auditId: string }>;
  execute(
    request: SqlRequest,
    context: DatabaseOperationContext,
  ): Promise<QueryResult>;
  cancel(queryId: string, context: DatabaseOperationContext): Promise<void>;
}
// Registry resolves hosts and credentials; browser contracts never carry a connection string.
// Allowlist catalog identifiers/filter ASTs, parameterize values, and enforce optimistic writes.
// Dedicated read-only/write DB identities and transaction limits enforce access; keyword filters do not.
// Bound output, cancel backend queries, and redact audited query parameters/results by column policy.
