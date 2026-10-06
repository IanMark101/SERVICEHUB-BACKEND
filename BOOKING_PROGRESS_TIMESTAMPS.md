# Booking progress timestamps

Branch: `feature/booking-progress-timestamps`, based on `development`.

This change adds `booking_progress_events` without altering existing booking,
queue, payment, messaging, authentication, or eligibility rules. Successful
acceptance, start, provider completion, seeker/admin confirmation, and
cancellation actions write server timestamps inside their existing transactions.
Retries keep the original time. A later cancellation approval retains a prior
decline, and repeated work-completion actions retain separate records.

The existing authenticated `/bookings/my-engagements` response includes the same
ordered history for both participants. Automatic paid-booking acceptance is
attributed to ServiceHub. No extra route or client-supplied timestamp is accepted.
The matching frontend displays the dates and times on both Activity cards in
Philippine time (UTC+8). Older unavailable times are not guessed from `updatedAt`.

## Release order

1. Review the backend and matching frontend feature branches.
2. Before merging or pushing backend `main` (which triggers automatic deployment),
   use a configured checkout of this backend feature branch with the intended database environment,
   install the locked dependencies (`npm ci`) and apply the additive migration:

   ```sh
   npx prisma migrate deploy
   ```

3. Merge and deploy the backend image containing the regenerated Prisma client, then merge and deploy
   the frontend through Vercel. Apply the migration before starting the new API;
   its reads and writes require the new table. The current Docker deploy script
   does not run Prisma migrations automatically.
4. Test one booking from acceptance through provider completion and seeker
   confirmation in both accounts. Check the same history and timestamps on both
   Activity cards. Test cancellation request/response and a page refresh.

The old backend can run with the additional unused table. Keep that table when
rolling back application code so recorded history is retained.

## Validation

```powershell
npm run db:generate
npm run build
npm test
$env:SERVICEHUB_BOOKING_PROGRESS_ONLY = '1'
npm run test:fresh-migrations
```

The last command creates a disposable schema, checks migration/schema parity,
runs booking-history, existing booking flows, cancellation-finalization, and
provider-workload integration tests, then removes only that disposable schema.
It does not migrate or change the production application schema.
This mode explicitly sets the connection's `search_path` to the disposable
schema, including raw SQL queries, and reports every suite's result before
failing when any suite fails. The history test verifies the raw SQL schema before
creating fixtures.

Verified: backend build and 97 schema tests pass. The isolated booking-history,
cancellation-finalization, and provider-workload integration suites pass, and
the complete fresh migration chain matches the Prisma schema without drift.

The existing `booking-flows.test.ts` currently has a stale assertion at line 284:
it expects a suspension-related rejection when dismissing a report with a penalty,
but the unchanged `assertReportDecision` rejects dismissed-report penalties first.
The existing test, admin policy, and report service were left unchanged. The new
booking-history integration test passes; report the existing assertion mismatch
separately rather than weakening the policy to make the test pass.
