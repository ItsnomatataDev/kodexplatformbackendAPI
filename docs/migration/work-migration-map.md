# Work / Cards / Tasks Migration Map

## Scope and evidence

This is discovery only. It does not create a Kode schema, migration script, or
target data. Facts below come from the legacy schema export
`public-schema-20260824T201843Z.sql` and data export
`public-data-20260826T071806Z.sql`.

Existing Kode migrations define only `identity`, `organizations`, and
`ingestion` domains. There is no existing Kode work/board/card schema or
application implementation to extend. The target names in this document are
therefore proposals for the next design step, not implemented tables.

## Source counts

| Legacy table | Rows | Notes |
|---|---:|---|
| `projects` | 0 | Empty in this export. |
| `task_columns` | 0 | Empty legacy project-column model. |
| `tasks` | 5,257 | Active work-record source. |
| `task_comments` | 34 | 16 `comment`, 18 `work_summary`. |
| `task_labels` | 0 | Empty. |
| `task_label_assignments` | 0 | Empty. |
| `task_watchers` | 2 | One watcher user across two tasks. |
| `task_updates` | 0 | Empty. |
| `task_submissions` | 0 | Empty. |
| `task_board_columns` | 195 | Direct dependency; this is the populated column model used by `tasks.column_id`. |
| `task_assignees` | 1,739 | Direct dependency; multi-assignee relation. |

All rows in the populated work tables belong to organization
`ae975c01-c044-4c5d-b5b5-4b6a06b55957`. The earlier identity migration already
preserved the organization and profile UUIDs needed for those relationships.

## Concept decision: `projects`

**Proposal: map legacy `projects` to a future `work.projects` concept — not to
`work.boards` or `workspaces`.**

This is based on the legacy schema: a project has an owner, dates, priority,
budget/billing fields, and optional client/campaign relationships; tasks and
the old `task_columns` reference it. Those are project-delivery attributes,
not workspace tenancy or a board-column definition. No `projects` rows exist
in this export, and every `tasks.project_id` is null, so the proposal produces
no records in this migration.

The populated board evidence is instead `task_board_columns`: 195 columns,
all with a null `project_id`, 194 with a `client_id`, and 10 names / 8 status
keys. `tasks.column_id` refers to this table (5,180 non-null references).
It should inform a separate `work.boards` / `work.board_columns` design around
client-scoped and internal boards. Since Kode has no work architecture yet,
the final board container and its client-domain dependency require explicit
design approval before implementation.

## Direct dependencies and deferred references

| Source table | Rows | Relationship to this migration | Handling proposal |
|---|---:|---|---|
| `organizations` | 2 | Parent of organization-scoped work data. | Require the already-migrated organization UUID. |
| `profiles` | 48 | Parent of every legacy user reference. | Resolve to preserved `identity.users.id`. |
| `task_board_columns` | 195 | Parent of `tasks.column_id`; populated source of board columns. | Include with the work migration. |
| `task_assignees` | 1,739 | Multi-assignee task relation; `tasks.assigned_to` is only a singular legacy field. | Include with the work migration. |
| `clients` | 35 | Referenced by 5,196 tasks and 194 board columns. | Do not migrate its domain here; defer target FK or retain legacy client UUID as an unresolved external reference until client migration. |
| `company_offices` | 4 | Referenced by 5,256 tasks. | Do not create an office FK in the first work migration; retain UUID as deferred metadata/reference. |
| `tickets` | 58 | Referenced by 46 tasks. | Do not create a ticket FK in the first work migration; retain UUID as deferred metadata/reference. |
| `campaigns` | 0 | Optional project/task relationship. | No populated dependency in this export. |

`task_members` is empty and duplicates the membership intent of populated
`task_assignees`; it is not a required import source. Attachments, checklists,
custom fields, reminders, time entries, and activity tables are outside this
focused work/cards/tasks scope and are not mapped here.

## Detailed table mapping

### `projects` → proposed `work.projects` (0 rows)

- **Primary key / legacy preservation:** `id` UUID primary key. On any future
  import, retain it as the target ID and record `legacy_source = 'supabase'`,
  `legacy_id = id`; do not generate replacement UUIDs.
- **Foreign keys:** `organization_id → organizations`; `created_by`, `owner_id
  → profiles`; nullable `client_id → clients`, `campaign_id → campaigns`.
- **Organization, user, and hierarchy:** organization-scoped; creator is
  required, owner optional. It is the parent of legacy `task_columns` and is
  optionally referenced by `tasks` and `task_updates`.
- **Important / direct-copy fields:** `name`, `slug`, `description`,
  `due_date`, `start_date`, `completed_at`, `metadata`, `created_at`,
  `updated_at`, `is_billable`, `budget_type`, `budget_limit`,
  `billing_currency`, `default_hourly_rate`, and `archived_at` are direct
  candidates after target type checks.
- **Status and ordering:** enum `status` permits `planned`, `active`,
  `on_hold`, `completed`, `cancelled`, `todo`, `in_progress`, `review`, and
  `done`; `priority` is `low|medium|high|urgent`. No position field.
- **Transformations:** user UUIDs resolve to identity; client/campaign UUIDs
  must be deferred until their domains exist; target status vocabulary must be
  explicitly mapped or preserved as a legacy status key. Validate all parent
  and child references before import. There are no source rows to validate in
  this export.

### `task_columns` → proposed legacy compatibility input only (0 rows)

- **Primary key / foreign key:** `id` UUID; `project_id → projects` (required,
  cascade delete).
- **Fields:** `name`, integer `position`, `created_at`; no organization or
  user field, status, metadata, or update timestamp.
- **Target proposal:** do not use it as the active column source. If populated
  in another export, normalize it to `work.board_columns` only after its
  `work.projects` parent is available; preserve its UUID and legacy trace.
- **Validation:** project must exist, columns must have deterministic ordering
  by `position, id`, and target project organization must be derived from the
  parent. It is empty here.

### `task_board_columns` → proposed `work.board_columns` (195 rows)

- **Primary key / foreign keys:** `id` UUID; required `organization_id →
  organizations`; nullable `project_id → projects`; nullable `client_id →
  clients`.
- **Organization and hierarchy:** all 195 rows are in the one organization;
  all `project_id` values are null; 194 rows have a client and one is an
  internal/no-client board column. This is the actual parent of
  `tasks.column_id`.
- **Important / direct-copy fields:** `name`, `color`, `position`,
  `status_key`, `created_at`, `updated_at`; directly retain ID and legacy
  trace. Board/container linkage is a transformation because no legacy board
  entity exists independently of client/project scope.
- **Status / ordering / metadata:** `status_key` values are `back_burner`,
  `backlog`, `blocked`, `done`, `in_progress`, `review`, `to_do_medium`, and
  `todo`; positions range 0–7 with no duplicate `(organization_id, client_id,
  position)` combinations. No metadata field.
- **Validation:** organization must resolve; non-null client/project must
  resolve or be explicitly deferred; every task's column must belong to the
  task organization. Preserve the source ID because task references depend on
  it.

### `tasks` → proposed `work.cards` (5,257 rows)

- **Primary key / legacy preservation:** `id` UUID primary key. Retain it as
  the card ID with `legacy_source = 'supabase'` and `legacy_id = id`.
- **Foreign keys:** required `organization_id → organizations`; nullable
  `project_id → projects`, `client_id → clients`, `campaign_id → campaigns`,
  `parent_task_id → tasks`, `assigned_to`, `assigned_by`, `created_by`, and
  `archived_by → profiles`; `column_id → task_board_columns`; `office_id →
  company_offices`; `ticket_id → tickets`.
- **Organization / users / hierarchy:** all rows have the same organization;
  `project_id`, `campaign_id`, and `parent_task_id` are null for every row.
  User fields are nullable and all populated values resolve to legacy
  profiles. `assigned_to` is populated on 942 tasks; the separate
  `task_assignees` relation is authoritative for multi-assignee data.
- **Important / direct-copy fields:** `title`, `description`, `department`,
  `due_date`, `start_date`, `completed_at`, `blocked_reason`, `ai_generated`,
  `metadata`, `created_at`, `updated_at`, `tracked_seconds_cache`,
  `is_billable`, `estimated_seconds`, `archived_at`, and
  `imported_time_status` can be copied subject to target type support.
- **Status / order:** statuses are `done` 3,822, `todo` 1,289,
  `in_progress` 90, `review` 32, `backlog` 18, `to_do_medium` 4,
  `back_burner` 1, and `blocked` 1. Priorities are `medium` 5,166, `urgent`
  58, `high` 29, and `low` 4. Position values are not unique (3,510 are 0),
  so preserve them but use `position, created_at, id` as a deterministic
  target ordering fallback; do not assume uniqueness.
- **Transformations:** map column and assignment relations after their
  parents; resolve identity UUIDs; preserve legacy status key until a target
  status vocabulary is approved; place client, office, ticket, campaign, and
  empty-project UUIDs into explicit deferred references rather than inventing
  target foreign keys. `imported_time_status` is only `not_requested` or null
  and should be retained as legacy metadata unless product behavior requires
  it.
- **Validation:** source IDs unique; organization resolves; all non-null
  `column_id` values resolve (5,180); all user IDs resolve; any non-null
  parent task must resolve and share organization; all deferred external
  references must be counted and recorded. Current source checks found zero
  missing organization, project, client, campaign, parent-task, column,
  office, or ticket references.

### `task_comments` → proposed `work.card_comments` (34 rows)

- **Primary key / foreign keys:** `id` UUID; required `task_id → tasks` and
  `organization_id → organizations`; nullable `user_id → profiles`.
- **Organization / users / hierarchy:** child of a task; all rows are in the
  one organization; one row has a null author and the other five distinct
  authors resolve to profiles.
- **Direct-copy fields:** `comment`, `is_internal`, `comment_type`,
  `created_at`, `updated_at`, plus ID and legacy trace.
- **Status / order / metadata:** comment types are `comment` (16) and
  `work_summary` (18); no status, position, or metadata field. Chronological
  order is `created_at, id`.
- **Transformations and validation:** map `task_id` to card ID and `user_id`
  to identity user; preserve `work_summary` as a type rather than flattening
  it into comment text. Require task and organization existence and matching
  task organization; source validation found no missing task or organization
  relationships.

### `task_labels` → proposed `work.labels` (0 rows)

- **Primary key / foreign keys:** `id` UUID; required `organization_id →
  organizations`; nullable `client_id → clients`.
- **Fields:** `name`, `color` (default `#f97316`), `created_at`; no user,
  hierarchy, status, position, or metadata.
- **Transformation / preservation / validation:** copy fields and preserved
  ID/legacy trace when populated; defer client linkage until its domain is
  migrated. Require organization and, where present, client resolution. No
  records exist in this export.

### `task_label_assignments` → proposed `work.card_label_assignments` (0 rows)

- **Primary key / foreign keys:** `id` UUID; required `task_id → tasks` and
  `label_id → task_labels`; unique `(task_id, label_id)`.
- **Fields and mapping:** pure child relation with no organization, user,
  status, position, timestamps, or metadata. Preserve its ID and legacy trace
  if a target relation has a surrogate ID; otherwise preserve `legacy_id` in
  relation metadata.
- **Validation:** both parents must exist and have the same organization;
  reject duplicate card-label pairs. It is empty here.

### `task_watchers` → proposed `work.card_watchers` (2 rows)

- **Primary key / foreign keys:** `id` UUID; required `task_id → tasks`,
  `user_id → profiles`, `organization_id → organizations`; unique
  `(task_id, user_id)`.
- **Organization / users / hierarchy:** task-child relation; both task and
  user references resolve; user is `d670f370-fdec-48b7-a46b-7a6150af665f`.
- **Direct-copy fields:** `created_at`, ID, and legacy trace. No status,
  position, or metadata.
- **Validation:** task, user, and organization must resolve; task organization
  must equal row organization; reject duplicate card-watcher pairs. Source
  checks found no missing task or organization relation.

### `task_updates` → proposed `work.card_updates` (0 rows)

- **Primary key / foreign keys:** `id` UUID; required `organization_id →
  organizations`, `task_id → tasks`; nullable `project_id → projects` and
  `user_id → profiles`.
- **Fields:** `update_type` (default `manual`), `message`, JSONB `metadata`,
  `created_at`; no update timestamp or position.
- **Mapping / validation:** retain message, type, metadata, timestamp, ID,
  and legacy trace; resolve parent card and optional author/project; require
  organization consistency. It is empty here.

### `task_submissions` → proposed `work.card_submissions` (0 rows)

- **Primary key / foreign keys:** `id` UUID; required `organization_id →
  organizations`, `task_id → tasks`, `submitted_by → profiles`; nullable
  `reviewed_by → profiles`.
- **Fields:** `submission_type` (`website|media|document|general`), `title`,
  `notes`, `link_url`, `file_path`, `file_name`, `mime_type`, `file_size`,
  `approval_status`, `reviewed_at`, `review_note`, `created_at`, `updated_at`.
- **Status / metadata:** approval enum permits `pending`, `approved`,
  `rejected`, `cancelled`; no position or metadata field.
- **Transformation / validation:** retain file locations as legacy references
  only—do not copy Supabase storage behavior. Resolve users, task, and
  organization; verify reviewer fields are internally consistent. It is empty
  here.

### `task_assignees` → proposed `work.card_assignees` (1,739 rows)

- **Primary key / foreign keys:** `id` UUID; required `task_id → tasks`,
  `user_id → profiles`, `organization_id → organizations`.
- **Purpose:** this is the populated many-to-many assignment source and must
  not be dropped in favor of singular `tasks.assigned_to`.
- **Direct-copy fields:** `created_at`, ID, and legacy trace. No status,
  position, or metadata.
- **Transformation / validation:** preserve each row and resolve card/user;
  deduplicate `(task_id, user_id)` only if target requires it, recording any
  removals. Require task/user/organization resolution and organization match.
  Source checks found zero missing task, user, or organization references.

## Required migration validation

1. Reconcile each imported source count, including `task_board_columns` and
   `task_assignees`, against target counts.
2. Require `legacy_source = 'supabase'` and `legacy_id = source id` for every
   target work record; use the source UUID itself as the target primary key
   wherever the target model has a surrogate ID.
3. Validate all listed required and populated optional foreign keys before
   committing; validate child organization equals parent task/board
   organization.
4. Validate status values against an explicit approved mapping. Do not silently
   collapse `to_do_medium`, `back_burner`, or `blocked`.
5. Validate parent-task acyclicity if a future export contains subtasks; this
   export has no non-null `parent_task_id` values.
6. Treat `client_id`, `office_id`, `ticket_id`, and future campaign/project
   references as deferred external links until their target domains exist;
   report counts rather than manufacturing placeholder records.
7. Use stable ordering fallback `position, created_at, id` for cards because
   legacy task positions are non-unique.

## Implementation boundary

No `0004_work.sql`, migration script, mock data, Supabase RLS, Supabase RPCs,
or Supabase triggers were created or copied during this discovery phase.
