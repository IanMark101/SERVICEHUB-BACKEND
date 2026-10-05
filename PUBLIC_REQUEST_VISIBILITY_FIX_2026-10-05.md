# Global public-request visibility fix

Post Request broadcasts a public job. It has no control for assigning the job
to a particular provider, and its API does not accept targeting fields.
Older provider-only metadata nevertheless restricted both Browse Jobs and
offer submission. The earlier audit incorrectly treated that metadata as an
intentional provider-only feature.

## Behavior

- Every eligible account receives the same open public jobs, regardless of
  account creation date or the provider ID stored on an older public record.
- Owners can see their own public job with its read-only card. Frontend and
  backend self-offer prevention remain in place.
- Public posting explicitly saves both target fields as null.
- A genuine legacy listing inquiry still requires its selected service and
  provider. It stays restricted to its participants.
- Admin content management and user-profile links use the same classification.
- Existing lifecycle and account eligibility checks continue to hide unavailable,
  paused, cancelled, fulfilled and otherwise ineligible jobs.

## Data repair and prevention

Migration `20261004160000_public_request_visibility` clears `targetProviderId`
only when `targetServiceId` is null. It applies to every matching record;
there are no account-specific IDs or names in the implementation.
The migration also installs a validated database constraint prohibiting a
provider restriction without a selected listing.

The targeted migration was applied transactionally to the configured application
database and recorded in its Prisma migration history. It repaired two records.
All 18 public-request records remain present; no obsolete restrictions remain.
The repair changed no request status, offer, booking, payment or account record.

Read-only verification after repair checked all five eligible accounts. Each
received the same two currently open public jobs. No live sessions, offers or
bookings were created for verification.

## Files

Backend request listing/creation, offer eligibility, public-content workspace,
public-content actions, admin user-profile classification, and the schema comment
were updated. Frontend Browse Jobs filtering and request mapping were updated.
The migration, scoped application script, read-only visibility audit, and
regression tests were added. The historical offer audit now includes a correction.

## Verification

- Frontend: 23 tests across Browse Jobs, Incoming Requests and Request Manager
  passed; frontend TypeScript and ESLint for changed files passed.
- Backend: 78 schema/contract tests and application TypeScript passed.
- Offer lifecycle: all 19 scenarios passed, including public multi-provider offers,
  listing-inquiry privacy, self-offer prevention and booking/payment safeguards.
- HTTP request-posting and admin user-profile integration checks passed.
- Global visibility integration: all four scenarios passed in a disposable schema:
  multi-record migration, five-viewer visibility, multi-provider offer submission
  and rejection of future invalid provider-only records.
- Fresh migration rehearsal: all 35 migrations applied and schema comparison
  reported no difference.
- Admin content lifecycle: all nine scenarios passed in its disposable schema.
- The same fresh-schema run also passed publication/moderation and self-service
  account-deletion regressions, then removed the disposable schema.
- Live read-only audit: five eligible accounts, two identical open public jobs
  per account, zero obsolete provider restrictions.

Frontend behavior was checked with rendered React component tests. Real
application data was checked through the request service with read-only queries.
No live account was impersonated or signed into for testing.

The global visibility integration log is
`.audit-results/audit_20260924_86b9b4a251714b11921b6c0799a5860c.log`.

## Repeatable checks

From the backend directory:

```powershell
# Read-only migration/data inspection
.\node_modules\.bin\tsx.cmd scripts/apply-request-visibility-migration.ts

# Read-only comparison across every eligible account
.\node_modules\.bin\tsx.cmd scripts/audit-public-request-visibility.ts

# Regression tests and migration repair in a fresh disposable schema
.\node_modules\.bin\tsx.cmd scripts/run-independent-audit.ts src/integration/request-visibility.test.ts
```

Refresh Browse Jobs after loading the updated application. Keep All Categories
and All quick filters selected when comparing accounts. An owner's job should
appear with its own-request label and no Send Offer button.
