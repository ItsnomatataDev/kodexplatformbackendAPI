# Attendance and task timers at 18:00 Africa/Harare

## Findings in the previous module

- Attendance had an API scheduler ticking every minute, but its session loop awaited each notification before processing the next profile. A clock-out or notification exception aborted the remaining loop. Sessions whose organization was missing from the active-organization lookup were skipped altogether. The cutoff also followed arbitrary organization overrides instead of one consistent 18:00 rule.
- Task time entries had no backend scheduled cutoff. The nearby frontend's `pauseRunningTimersAt6pmForOrganization` function issued PATCH requests from the browser. Closed tabs, sleeping devices, absent admin sessions, or failed browser requests could leave timers open indefinitely.
- The frontend `resumeTimeEntry` explicitly rejected resume after 18:00 with “Time tracking stops at 6:00 PM Harare time.” This conflicts with allowing a deliberate resume.
- Code inspection identifies these failure paths. It does not prove which one affected a particular live profile without its session data/logs.

## Backend behavior

Both attendance and task timers now use **18:00 Africa/Harare (16:00 UTC)** regardless of the VPS or browser timezone. Office presence-only mode keeps attendance work seconds at zero but still clocks out the session. Missing profiles/offices and suspended organizations do not exempt existing open sessions from cleanup. Attendance absence marking remains a separate weekday rule.

The API scheduler starts at server startup and runs both jobs independently every minute. A tick closes records at the exact cutoff timestamp even if the tick runs later. After downtime, the first tick closes overdue records at their original cutoff, not the restart time. Attendance and timer API reads/writes also reconcile overdue rows.

One failed attendance session does not block other profiles. Failed sessions remain open and are retried on the next tick. Clock-outs finish before notifications run; notification errors are logged without reopening the sessions or blocking other clock-outs. Concurrent attempts only count sessions actually changed.

Task timers save `ended_at`, `auto_stopped_at`, elapsed `seconds`, and card cached totals in one PostgreSQL transaction. Completed, deleted, and manual entries without a start timestamp are not stopped by the job. Concurrent scheduler runs lock batches safely. Automatically stopped segments cannot be reopened, moved to a different start time, or have their seconds overwritten by stale browser updates. Such PATCH requests receive HTTP 409 with code `TIME_ENTRY_AUTO_STOPPED`. Matching repeat stop requests and edits to notes/billable status remain allowed.

An explicit Start/Resume creates a **new segment**. A segment started before 18:00 stops at that day's 18:00. A segment started at or after 18:00 runs until the next day's 18:00 unless manually stopped sooner. There is no automatic resume; the paused interval is never added to the new segment. Attendance can similarly be explicitly clocked in again after the automatic clock-out.

API additions:

- Time entries: `autoStoppedAt` is the automatic cutoff for a closed segment or null. `autoStopAt` is the next automatic cutoff for a running segment or null.
- Attendance sessions: `autoClockOutAt` is the next automatic cutoff for an open session or null. Existing clock-out fields show actual closure.
- A manual attendance clock-out submitted after automatic closure returns the already closed session after checking the caller's authorization.

## Required frontend follow-up

Keep the existing backend API integration and make these focused changes in the frontend repository:

1. Remove the after-18:00 rejection in `src/lib/supabase/mutations/timeEntries.ts`'s Kode `resumeTimeEntry` path. Resume must create a new entry via the existing card time-entry POST, copying the card, note, and billable setting, with `seconds: 0`, `startedAt` equal to the current time, and `endedAt: null`. It must never reopen the old entry. Keep organization/ownership checks and the existing check for another running timer.
2. Map `autoStopAt` and `autoStoppedAt` from Kode into the timer view model. Use the returned ISO cutoff when clamping live display time. Recalculate/reconcile server state at that cutoff, on tab focus, and after a successful resume. For attendance use `autoClockOutAt` in the same way.
3. Ensure old browser functions do not immediately stop a newly resumed post-18:00 segment using that same day's already-passed cutoff. Prefer server-provided `autoStopAt`; the new segment's cutoff is the following day. Remove any separate after-18:00 UI restriction that blocks the requested deliberate Resume action.
4. Refetch `/api/time-entries/running` and the entry list periodically while a timer is displayed. Once `endedAt` is populated, stop visual tracking and clear the running state. Refresh on HTTP 409 `TIME_ENTRY_AUTO_STOPPED`; show an explanation and the option to resume.
5. Do not depend on a browser/admin tab to run organization-wide auto-stop PATCH calls. The backend now performs the daily job. Preserve manual Stop and intentional Resume actions.
6. Verify with real API data: pre-18:00 timer stops, display freezes at its cutoff, Resume after 18:00 creates a separate segment without counting the gap, a tab reopened after the cutoff reflects the server, and attendance is closed for both time-tracked and presence-only profiles.

The frontend checkout was inspected but not edited during this backend task. Its existing after-18:00 Resume restriction remains until this follow-up is applied.

## Release

Migration **0058_time_entry_auto_stop.sql must succeed before restarting this backend**. The previous handover release already applied migrations through 0057 on the VPS. No VPS changes were performed for this end-of-day fix.

Upload this release's source files from the local Mac; the manifest includes `src/server.ts` so the running API actually starts the scheduler:

```sh
cd /Users/thando/Desktop/devprojects/kode-platform
rsync -av --files-from=scripts/deploy/end-of-day-files.txt ./ root@128.140.124.44:/opt/kode-platform/
ssh root@128.140.124.44
```

Follow the project's existing VPS deployment prerequisites. On the VPS, run in order, continuing only after each succeeds:

```sh
cd /opt/kode-platform
docker compose --env-file .env.vps -f docker-compose.vps.yml build api
docker compose --env-file .env.vps -f docker-compose.vps.yml run --rm --no-deps api node dist/cli/migrate.js
docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --no-deps --force-recreate api
curl --fail --max-time 10 https://api.tmctechsolutions.com/health/ready
docker logs --since 5m kode-vps-api 2>&1 | grep -E 'End-of-day scheduler started|End-of-day job failed|auto clock-out|automatically stopped'
```

Startup logs should include `End-of-day scheduler started` with both `attendance` and `time_entries`, 60,000ms interval, and the Harare cutoff. Avoid rerunning host npm commands: the VPS runs Node/npm inside Docker.

The new image also has a one-off catch-up command, using its configured runtime database. This performs real updates on overdue open records:

```sh
docker exec kode-vps-api node dist/cli/end-of-day.js
```

## Verification

Build and typecheck, then run real PostgreSQL tests against a migrated disposable database:

```sh
npm run build
npm run typecheck
DATABASE_NAME=kode_obligations_leave_test npm run test:end-of-day:postgres
```

The test uses actual database triggers to simulate failed notification, session, and card-cache writes. Coverage includes exact cutoff timestamps, downtime catch-up, >500 records, concurrent jobs, rollback, stale updates, explicit resumed segments, presence-only and missing-profile users, suspended organizations, and read reconciliation. Test fixtures are removed afterward. A database connection failure fails this explicitly enabled command.
