# Ticket assignment and IT access audit

## Findings and changes

- Backend had no assignment timestamp. Migration `0062_ticket_assignment_board.sql` records `assigned_at` on creation with an assignee and on reassignment, preserves it on unchanged assignments, and clears it on unassignment. The authenticated API returns `assignedAt`. Existing unknown times remain null.
- Frontend `ITSupportPage.tsx` omitted comment authors even though the API supplies them. It now displays authors and the current technician/assignment time. `src/lib/kode/tickets.ts` maps the new field into `ServiceDeskTicket.assigned_at`.
- Backend assignment did not create a Work card. The legacy frontend repository contains Supabase triggers implementing this behavior; these were absent from Kode. Migration 0062 restores transactional board/card creation, reuses existing linked cards and the renamed Support Tickets board, synchronizes assignees, and backfills active assignments. Concurrent first assignments are serialized per organization. Closing moves a card to Review; resolution moves it to Done; reopening moves it to In Progress. Existing board layouts/cards are retained.
- Technician and comment names now fall back to the identity email when profiles are absent or blank. Deleted author identities cannot be reconstructed from this change.
- Initial local account `Bridget N` (`cd184604-a015-466d-a409-773be98db0ae`) is pending, has no role, and has no organization membership. The user subsequently confirmed the same state in live PostgreSQL. Existing local active IT members have ticket permissions. Frontend intentionally allows `/it/support` for other-office IT while restricting platform control pages to ITs No Matata IT. No broad permission changes were made.
- Non-staff ticket visibility remains requester-only. This does not explain missing tickets for correctly configured IT members; changing that policy is outside this IT-role fix.

## Validation

- Backend typecheck and full suite: 320 passed, 10 skipped.
- Frontend TypeScript build passed using Node 22 (the machine's Homebrew Node installation has a missing library).
- Isolated PostgreSQL schema: migration applied; `tests/ticket-assignment-postgres.sql` passed assignment, reassign, unassign, no-op timestamp, card deduplication, status mapping, and unknown-history checks.
- `RUN_TICKET_DB_TESTS=true node --import tsx --test tests/ticket-assignment-postgres.test.ts` passed against the isolated database, verifying real store queries, missing/blank profile fallbacks, attribution, assignment persistence, and organization isolation.
- SSH to `root@128.140.124.44` reached the server but authentication was rejected (`Permission denied (publickey,password)`). No live deployment or browser session verification performed.

## Deployment and remaining live check

Backend files: migration 0062, `src/routes/tickets.ts`, and `src/tickets/{store,memory-store,postgres-store}.ts`.
Frontend repository: `ITsNomatataWorkSpace`, files `src/lib/kode/tickets.ts`, `src/features/service-desk/services/serviceDeskService.ts`, and `src/features/it-workspace/pages/ITSupportPage.tsx`.

Reconcile the live migration ledger with the release before running migrations: this workspace includes unrelated pending changes and migration history work. Deploy migration 0062 before the new backend because its queries require `assigned_at`. Then deploy backend and frontend together. The migration backfills active assignments and can hold locks; use the normal deployment window.

Run `scripts/diagnostics/ticket-access-audit.sql` against live PostgreSQL using existing server credentials. It is read-only. Confirm Bridget's identity, organization, office, active account/membership and IT role before applying a targeted account repair. Do not change every role or bypass route guards to repair one account.

After deployment, assign a ticket and confirm technician/time, author on an internal note, and a single linked card on Tickets. Reassign and confirm the existing card changes technician. Verify Bridget's `/it/support` access with her actual session.

## Live follow-up — 2026-10-10

The user ran the read-only audit on `kode-vps-postgres`: 61 active assigned tickets, 15 missing linked cards, and 2 mismatched card assignees. Bridget was pending with no membership.

The user confirmed Bridget belongs to Shearwater Tech Team and executed `scripts/repairs/bridget-shearwater-it.sql` on the live database. The output showed `COMMIT`, account status `active`, membership status `active`, role `it`, and office `Shearwater Tech Team`. The account repair is complete; verification through Bridget's actual session is still outstanding. No role-wide permission changes were made.

Ticket code and migration 0062 remain undeployed. Next inspect the running API's Compose directory/config labels and the live migration ledger before selecting the release commands.

### Confirmed live deployment

The user applied the ticket release transaction: 61 assigned active tickets, zero missing linked cards, zero mismatched card assignees, and COMMIT. Migration 0062 is recorded; 0060/0061 were not applied in this ticket release.

The ticket backend patch was applied in `/opt/kode-platform` and rebuilt. The original running image could neither be tagged nor committed due to missing Docker content. An available older API image was retained as `kode-api:available-before-ticket-fix` (not an exact copy of the previously running image), and the four source files were archived before patching.

The replacement image `sha256:d815f0a097003456b9f235743374f653e8b568345795e55960929865ce5a3676` was started successfully. User-supplied output confirms container `kode-vps-api` running/healthy, Redis pub/sub connected, health endpoint 200, and authenticated application requests returning 200. Frontend deployment and end-to-end ticket UI verification remain outstanding.
