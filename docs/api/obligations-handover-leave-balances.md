# Monthly obligation handover and leave balances

## Deployment

Apply migration `0057_obligation_handovers.sql` using `npm run migrate` before restarting the backend with this release. No production database was changed during development. The integration tests used an isolated local PostgreSQL database with the existing schema and the new migration.

## Handover

`POST /api/obligations/:obligationId/handover`

```json
{ "assigneeId": "recipient-user-uuid", "note": "Please take over monthly reporting." }
```

Returns `{ obligation, handover }`. Obligation fields use the existing snake_case shape; `handover` contains `id`, `organization_id`, `obligation_id`, `from_user_id`, `to_user_id`, `actor_user_id`, `note`, and `created_at`.

- The current assignee, admin, manager, or IT staff may transfer an active obligation.
- The recipient must be an active user with active membership in the same organization.
- This transfers ongoing responsibility for the recurring obligation, including its open occurrences and future months. It is not a temporary delegation of one month.
- Existing occurrence IDs, due dates, completion status, submission notes, and `submitted_by` are preserved.
- The former owner loses submission rights immediately; the new owner sees the obligation in their list/dashboard. Staff PATCH assignee changes use the same transaction and audit mechanism for compatibility.
- Archived obligations cannot be handed over. Same-owner explicit handovers return 409. Invalid recipients return 400; unauthorized actors return 403; obligations outside the authenticated organization return 404.
- Note is optional, at most 2,000 characters. `assignee_id` is accepted as an alias.
- Concurrent handovers lock the obligation row. Ownership and audit are committed together, or neither is saved.

`GET /api/obligations/:obligationId/handovers?limit=50&offset=0` returns `{ handovers, hasMore }`, newest first, visible to the current assignee and staff.

Frontend integration: choose a real active organization member from the directory, call the POST, then refetch obligation lists, dashboard, calendar, and handover history. Show server errors and prevent double submission. No synthetic success responses or local-only reassignment. Notifications are not sent by this endpoint.

## Leave Balance view

Use the employee endpoint for the employee picker/table, independently of whether audit history exists:

- `GET /api/leave/balance/employees?officeId=<uuid>` returns `{ employees }` with `id`, `office_id`, `full_name`, `email`, `primary_role`, `leave_days_total`, and `leave_days_remaining`.
- `GET /api/leave/balance/audit?officeId=<uuid>&userId=<uuid>&limit=50` returns `{ entries }`, which are **changes**, not an employee roster. An employee with no changes still appears in `employees`.
- Omit `officeId`/`userId` for all. Empty strings and `all` are accepted as no filter. Other non-UUID values return 400. Office membership is authoritative, falling back to the legacy profile office when membership has none.
- Missing profiles do not hide active members; their default entitlement/balance is 22 days. Deleted users/profiles are excluded.
- `PATCH /api/leave/balance/:userId` accepts `{ totalDays, remainingDays, note }`. Values must be whole non-negative days and remaining must not exceed total. The employee must belong to the authenticated organization. Profile creation, balance write, and audit write are atomic.
- Balance tools require existing leave-management authorization. Ordinary users cannot list or modify other employees' balances.

Frontend follow-up: load employees on opening Leave Balance; keep employee loading independent from audit/calendar failures; display errors rather than treating failed requests as empty arrays; use `employees`, not `entries`, as the picker source; preserve the selected office filter; refetch employees and history after a successful update.

The reported deployed behavior (users visible on Leave, empty Leave Balance view) was not reproduced against the local backend. The nearby frontend checkout does not contain the same separate tab described by the user. Backend fixes and real HTTP/store tests pass, but verification against the deployed frontend remains outstanding; do not mark that UI defect resolved based on these tests alone.

## Verification

`npm run test:obligations-leave:postgres` explicitly opts into real database tests, using the configured database. Use a migrated disposable test database, for example:

```sh
DATABASE_NAME=kode_obligations_leave_test npm run test:obligations-leave:postgres
```

Tests create uniquely identified fixtures and delete them afterward. Database unavailability is a failure, not a skip, when explicitly run with this command. Coverage includes authorization, foreign recipients, owner transitions, preserved completion, compatible PATCH updates, concurrent transfers, archives, employee lists without profiles, office filters, durable balances, audit entries, and rollback when audit insertion fails.
