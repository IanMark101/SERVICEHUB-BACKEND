# ServiceHub Cordova Capstone Readiness Tracker

Last audited: September 4, 2026

Authoritative specification: `SERVICEHUB_MASTER_PROMPT.md` Version 2.2

Working branch: `fix/admin-security-hardening`

Current estimated capstone readiness: **82%**

## Readiness summary

| Area | Readiness | Current assessment |
| --- | ---: | --- |
| Core marketplace flows | 85% | Flow A, Flow B cash, and concurrent paid queue lifecycle tests pass; live external payment verification remains |
| Authentication and session security | 91% | Strong sessions plus versioned verification consent, private proof access, retention rules, and deletion requests |
| Payment and queue integrity | 90% | Database constraints, transactional service locks, and concurrent lifecycle tests pass |
| Admin operations | 89% | Safety evidence, review moderation, promotion, deletion, and audit-log workflows are guarded and auditable; broader release testing remains |
| Messaging, realtime, and notifications | 78% | Functional; pagination, durability, and request fan-out need polish |
| Reviews, trust, community, and AI | 72% | Review visibility moderation is implemented; aggregate correctness and AI eligibility still need fixes |
| UX and code quality | 64% | Fake deletion behavior is removed; lint, remaining placeholders, terminology, and large files remain |
| Testing and deployment readiness | 64% | Phase 2-4 integration and booking-flow regressions pass; frontend E2E and load automation remain |

Additional estimates:

- Onsite-cash demonstration readiness: **85%**
- Full capstone defense readiness: **82%**
- Real production readiness: **54%**

## Completion order

Work through these phases in order. Do not mark an item complete until the associated implementation and verification evidence both exist.

### Phase 1 - establish a reproducible baseline - **DONE**

- [x] Review and group the existing backend source changes. **DONE — security/payment/queue hardening, controller/service refactor, migrations, and executable tests reviewed as one baseline.**
- [x] Review and group the existing frontend source changes. **DONE — component/hook refactor, auth/session handling, Admin flows, payment wording, and help content reviewed as one baseline.**
- [x] Stop tracking generated backend `dist` files and confirm production builds regenerate them correctly. **DONE — `/dist` is ignored, tracked count is zero, and `npm run build` recreated `dist/src/server.js` successfully.**
- [x] Commit the intended backend changes on `fix/admin-security-hardening`. **DONE — baseline commit `dcb0b9d`.**
- [x] Commit the intended frontend changes on `fix/admin-security-hardening`. **DONE — baseline commit `dc46ef0`.**
- [x] Push both branches and verify the remote branch contains the current implementation. **DONE - backend baseline reached `68cf517`; frontend reached `dc46ef0` on `origin/fix/admin-security-hardening`.**
- [x] Confirm both working trees are clean after builds, excluding deliberately ignored output. **DONE - both trees were clean; generated backend `dist` remained present and ignored.**

Phase 1 verification evidence:

- Backend `npm run build`: passed.
- Backend `npm test`: 14/14 passed.
- Backend `npm run test:booking-integration`: 1/1 passed.
- Frontend `npm run build`: passed; 90 routes generated.
- `npx prisma validate`: passed.
- `git diff --cached --check`: passed before both baseline commits.
- Staged secret scan: only documented `.env.example` placeholders and a dummy webhook test value matched.

### Phase 2 - queue and lifecycle concurrency - **DONE**

- [x] Move queue recalculation into the same transaction and service lock as payment, start, completion, cancellation, and removal mutations. **DONE - payment finalization, Start Job, completion, refund, and cancellation now mutate/reindex under one service lock; user removal is implemented as non-destructive visibility hiding and does not remove an active queue row.**
- [x] Add database protection for positive and unique active queue positions where practical. **DONE - migration adds positive position checks, unique active service positions, one SERVING row per service, and one ONGOING booking per provider.**
- [x] Make QueueNotify capacity checks and notification consumption atomic and idempotent. **DONE - the service lock covers capacity selection, durable notification creation, and waitlist-row consumption in one transaction.**
- [x] Add concurrent tests for payment finalization, queue insertion, cancellation, completion, reindexing, and Start Job. **DONE - `npm run test:phase2-integration` covers each race and duplicate webhook fulfillment.**
- [x] Correct CompletionEscalation retry cooldown from 24 hours to 72 hours. **DONE.**
- [x] Return the existing active CompletionEscalation for duplicate requests instead of creating another record or returning an ambiguous conflict. **DONE - PENDING and UNDER_REVIEW duplicates return the existing row under a booking advisory lock, backed by a partial unique index.**
- [x] Add durable administrator notification when a completion escalation is created. **DONE - active administrators receive stored notifications in the same creation transaction.**
- [x] Test the 72-hour initial threshold, duplicate behavior, `KEEP_AWAITING`, and second 72-hour threshold. **DONE - all four cases pass in the Phase 2 integration suite.**

Phase 2 verification evidence:

- `npm run test:phase2-integration`: 1/1 concurrency scenario passed (payment, queue, Start Job, completion, cancellation, waitlist, and escalation assertions).
- Backend `npm test`: 14/14 passed.
- Backend `npm run test:booking-integration`: 1/1 passed.
- Backend `npm run build`: passed.
- Frontend `npm run build`: passed; 90 routes generated.
- `npx prisma validate`: passed.
- `npx prisma migrate status`: database schema is up to date with 11 migrations.
- Backend and frontend `git diff --check`: passed.

### Phase 3 - privacy, verification, and deletion - **DONE**

- [x] Require verified email before residency-document upload and submission. **DONE - both upload and submission routes enforce the email gate, with a service-level defense in depth check.**
- [x] Add a versioned privacy notice and required acknowledgement checkbox. **DONE - the UI loads the server-owned current notice and cannot submit until it is accepted.**
- [x] Store privacy-notice version, acknowledgement timestamp, and user identity with each verification submission. **DONE - all fields are required by the database; legacy rows were explicitly labeled during migration.**
- [x] Redact internal verification `storageKey` values from ordinary responses. **DONE - submit, personal status, and administrator queue responses expose metadata only.**
- [x] Record an immutable AdminAuditLog entry whenever an administrator views or downloads a private document. **DONE - private signed URLs are issued only by a dedicated audited endpoint with distinct view/download actions.**
- [x] Define document retention periods and legal/active-case holds. **DONE - 365-day minimum, review-date reset, explicit legal hold, computed active-case hold, and purge eligibility are documented and implemented.**
- [x] Implement a real account-deletion request endpoint and status model. **DONE - authenticated create/read/cancel endpoints persist PENDING, BLOCKED, CANCELLED, or COMPLETED state.**
- [x] Block final deletion while nonterminal bookings, held payments, cancellations, reports, or escalations remain. **DONE - the shared blocker calculation covers every listed obligation and stores a BLOCKED request; guarded final administrator deactivation was subsequently completed in Phase 4.**
- [x] Replace the frontend's simulated account-deletion alert with the real workflow. **DONE - the danger zone now calls the API and displays persisted blockers/status.**
- [x] Correct the deletion UI so it does not promise removal of legally retained transaction/audit records. **DONE - the confirmation explains administrator review, anonymization/retention, and active-obligation requirements.**

Phase 3 verification evidence:

- `npm run test:phase3-integration`: 1/1 passed, covering email gating, versioned acknowledgement, redaction, audited access, retention holds, and deletion blockers.
- Backend `npm test`: 14/14 passed.
- Backend `npm run test:phase2-integration`: 1/1 passed after the Phase 3 migration.
- Backend `npm run test:booking-integration`: 1/1 passed after the Phase 3 migration.
- Backend `npm run build`: passed.
- Frontend `npm run build`: passed; 90 routes generated.
- `npx prisma validate`: passed.
- Migration `20260904150000_verification_privacy_account_deletion` applied successfully.
- Retention policy: `docs/VERIFICATION_DOCUMENT_RETENTION.md`.

### Phase 4 - safety, moderation, and administrator safeguards - **DONE**

- [x] Add a general booking-participant safety-report endpoint. **DONE - `POST /api/bookings/:id/reports` validates and persists participant safety reports.**
- [x] Allow either participant to report the other from documented eligible booking states. **DONE - seeker and provider directions are enforced and documented in `docs/SAFETY_AND_ADMIN_MODERATION.md`.**
- [x] Store evidence through private, booking-authorized storage. **DONE - authenticated booking-scoped uploads, ownership validation, redacted responses, and audited short-lived administrator access are implemented.**
- [x] Deduplicate active reports for the same booking/reporter/type. **DONE - an advisory lock plus a partial unique database index makes retries return the existing active report.**
- [x] Add review visibility/moderation state. **DONE - reviews now retain visibility, reason, moderator, and moderation timestamp.**
- [x] Add administrator review-hide/restore actions with reason and immutable audit log. **DONE - the API and Admin Review Moderation page support both actions, and public aggregates exclude hidden reviews.**
- [x] Require current-administrator password reauthentication before promoting another administrator. **DONE - the acting administrator's current bcrypt password is required and verified.**
- [x] Block administrator promotion when the target has active bookings, held payments, or unresolved cases. **DONE - promotion reuses the complete active-case guard and is transactionally rejected when blockers exist.**
- [x] Implement guarded final account deactivation. **DONE - only pending deletion requests without recalculated blockers may be finalized; sessions are revoked, sockets disconnected, and the action audited.**
- [x] Add a paginated administrator audit-log API and dashboard view. **DONE - filters, actor/target context, pagination, and a dedicated Admin page are implemented.**
- [x] Paginate escalated cancellations, announcements, reconciliation results, and other remaining unbounded administrator lists. **DONE - all top-level administrator collections are bounded by server-side page limits; overview widgets remain intentionally bounded summaries.**

Phase 4 verification evidence:

- `npm run test:phase4-integration`: 1/1 passed, covering both participant directions, report deduplication, evidence ownership/redaction/audited access, review hide/restore, promotion reauthentication/blockers, and final deactivation.
- Backend `npm test`: 14/14 passed.
- Backend `npm run test:phase2-integration`: 1/1 passed after the Phase 4 migration.
- Backend `npm run test:phase3-integration`: 1/1 passed after the Phase 4 migration.
- Backend `npm run test:booking-integration`: 1/1 passed after the Phase 4 migration.
- Backend `npm run build`: passed.
- Frontend `npm run build`: passed; 93 routes generated.
- `npx prisma validate`: passed.
- `npx prisma migrate status`: 13 migrations applied; database schema is current.
- Migration `20260904180000_safety_moderation_admin_guards` applied successfully.
- Policy: `docs/SAFETY_AND_ADMIN_MODERATION.md`.

### Phase 5 - listing, review, trust, and AI correctness - **IN PROGRESS**

- [ ] Return an approved listing to `PENDING_REVIEW` after material description, media, proof, title, or category edits.
- [x] Enforce the three-listing maximum transactionally under concurrent creation. **DONE - provider lock and concurrent four-create integration test.**
- [x] Implement normalized, active-only duplicate-title protection while allowing safe title reuse after deletion. **DONE - partial unique index and archive/reuse/duplicate-edit integration assertions.**
- [x] Align listing title and description minimum lengths with the Master Prompt. **DONE - 10/30-character minimums in API validation and create/edit forms; both builds pass.**
- [x] Do not store an authoritative direct-booking price for `CUSTOM` listings. **DONE - nullable database price and tested transition rules.**
- [x] Require at least one payment method during listing updates. **DONE - shared validation, edit-form gate and negative test.**
- [ ] Align Card, GCash, Maya, and onsite-cash support between listing configuration and booking/payment APIs.
- [ ] Make advanced price types usable only through an exact provider Offer in both UI and API.
- [x] Replace the fake `cert_uploaded.jpg` skill proof with managed storage or remove the field. **DONE - removed the fake argument from the listing creation path.**
- [ ] Restrict provider rating, ranking, and AI aggregates to eligible reviews where the target participated as provider.
- [ ] Keep seeker-role reviews in profile history without affecting provider metrics.
- [ ] Route every trust change through one transactional trust service.
- [ ] Give every business trust event a unique idempotency key.
- [ ] Stop exposing another user's exact private trust-event history.
- [x] Require five eligible written provider reviews before calling Gemini. **DONE - mocked integration proves zero calls at four, one at five, and fallback after hiding the fifth review.**
- [x] Persist/cache summaries by provider and review-content version or clearly document an intentional cache strategy. **DONE - persisted fingerprint cache and reuse test; strategy documented in `docs/PHASE5_IMPLEMENTATION.md`.**
- [x] Add defense seed data with five valid completed bookings and eligible written reviews. **DONE - opted-in seed executed September 5; all records are labelled DEMO.**
- [x] Replace hardcoded named landing testimonials with real seed data or clearly labelled demonstration content. **DONE - landing provider previews and illustrative figures explicitly labelled as demo/sample content.**

Phase 5 progress evidence (September 5, 2026):

- Backend and frontend production builds passed; frontend generated 93 routes.
- Backend contracts: 14/14 passed.
- Phase 4 safeguards integration: 1/1 passed.
- Booking lifecycle integration: 1/1 passed (a pg overlapping-query deprecation warning remains to trace).
- Initial Phase 5 integration: listing concurrency, title reuse, custom prices, trust retry idempotency, Gemini threshold and persisted-cache assertions passed.
- Maya selectors are wired and Card is explicitly unavailable; full browser/payment-method checks remain pending.
- Shared trust mutations, privacy gates and provider/seeker review separation are implemented; remaining edge-case verification stays unchecked above.
- Changes are local and uncommitted. Overall readiness remains **82%** until Phase 5 is fully verified.

### Phase 6 - PayMongo Test Mode and external integration - **NOT STARTED**

- [ ] Configure `PAYMONGO_WEBHOOK_SECRET` without committing it.
- [ ] Configure a public HTTPS Test Mode webhook endpoint and required event subscriptions.
- [ ] Make missing production environment-variable errors identify the actual missing fields.
- [ ] Run a real Test Mode Flow A online checkout.
- [ ] Run a real Test Mode Flow B online checkout.
- [ ] Replay a successful webhook and prove one PaymentAttempt, Booking, and Queue row.
- [ ] Test failure and expiry rollback for a Flow B payment hold.
- [ ] Test capacity loss after capture and the `REFUND_REQUIRED` reconciliation path.
- [ ] Run an actual Test Mode refund and verify administrator reconciliation.
- [ ] Retain clear wording that this is an internal Test Mode ledger, not regulated escrow or real provider payout.
- [ ] Configure and retest Google OAuth with project-owned credentials and authorized origins.

### Phase 7 - automated test coverage - **NOT STARTED**

- [ ] Add backend tests for every Tier 0 unauthorized and duplicate-event requirement.
- [ ] Test that an unverified email cannot submit verification or perform marketplace mutations.
- [ ] Test suspended-user resolution access and blocked new marketplace relationships.
- [ ] Test that a suspended provider cannot Start Job.
- [ ] Test that suspension, banning, or final deactivation cannot strand held payments.
- [ ] Test both participant directions for after-start cancellation approve, decline, and escalation.
- [ ] Test general safety reports and review moderation.
- [ ] Test duplicate completion disputes and completion escalations.
- [ ] Add frontend unit/component tests for authentication, forms, lifecycle controls, and admin decisions.
- [ ] Add browser E2E coverage for Flow A cash, Flow A online, Flow B cash, Flow B online, cancellation, completion, escalation, dispute, and refund.
- [ ] Apply all migrations to a fresh isolated database in CI.
- [ ] Add load/concurrency testing for queues, messages, notifications, and payment webhooks.
- [ ] Add dependency, secret, and static-security checks to CI.

### Phase 8 - UI, performance, and code-quality polish - **NOT STARTED**

- [ ] Resolve the frontend ESLint baseline: 359 errors and 341 warnings across 81 files at the last audit.
- [ ] Remove unused variables and replace avoidable explicit `any` types.
- [ ] Resolve React effect/state, dependency, purity, ref, and immutability warnings.
- [ ] Replace remaining `window.prompt` and `alert` interactions with validated application modals.
- [ ] Persist or remove notification and profile-visibility preference toggles.
- [ ] Implement helpful-review voting on the backend or remove its shared-count presentation.
- [ ] Replace misleading `escrow`, `payout`, `wallet`, and `funds released` labels with Test Mode internal-ledger wording.
- [ ] Paginate conversations, notifications, and transactions.
- [ ] Lazy-load report message histories instead of including every message in report-list responses.
- [ ] Reduce dashboard refresh fan-out and remove redundant transaction derivation/fetching.
- [ ] Add request-specific rate limits for messages, reviews, reports, payment initiation, and waitlist operations.
- [ ] Add security headers, request IDs, structured logging, and production-safe error context.
- [ ] Finish splitting the remaining 400-530-line frontend components and hooks by feature responsibility.
- [ ] Remove or gate unnecessary production console logging.

### Phase 9 - documentation and final release gate - **NOT STARTED**

- [ ] Reconcile `SECURITY_REAUDIT.md` with executable evidence and remove overstated claims.
- [ ] Replace unsupported PASS labels in `SOFTWARE_TEST_DOCUMENT.md` with Passed, Failed, Not Run, or Not Implemented.
- [ ] Remove claims that session booking, live payout, AI persistence, or unexecuted flows are verified.
- [ ] Document deployment, backup, restore, rollback, webhook recovery, and known limitations.
- [ ] Run frontend and backend production builds.
- [ ] Run all backend, integration, frontend, and E2E tests.
- [ ] Run Prisma validation, target migration status, schema drift check, and fresh-database migration test.
- [ ] Run fresh production dependency audits for both repositories.
- [ ] Run tracked-secret and private-document scans.
- [ ] Confirm browser and server logs contain no unexplained 4xx/5xx loops, duplicate listeners, or unhandled rejections.
- [ ] Perform the complete manual defense rehearsal using documented seed accounts and evidence screenshots/logs.
- [ ] Recalculate the readiness score and issue the final release decision.

## Features intentionally deferred or hidden

The following Master Prompt Tier 1/Tier 2 features may remain deferred as long as their controls are disabled or clearly labelled and the primary defense does not depend on them:

- Session-based scheduling and collision-safe time-slot reservations.
- Recurring contracts and calendar synchronization.
- Private booking-authorized message images.
- Real provider payouts, withdrawals, commissions, subscriptions, or Live Mode money.
- AI Service Matching and other bonus AI assistants.
- Provider workload forecasting beyond the one-ongoing-job safety guard.
- Automated multi-account collusion detection.

## Last executed evidence

| Verification | Last result |
| --- | --- |
| Frontend production build | Passed; 93 routes generated |
| Backend production build | Passed |
| Backend contract tests | 14/14 passed |
| Database-backed booking/payment/queue integration | 1/1 passed |
| Phase 2 concurrency integration | 1/1 passed after Phase 4 changes |
| Phase 3 privacy/deletion integration | 1/1 passed after Phase 4 changes |
| Phase 4 safety/admin safeguards integration | 1/1 passed |
| Prisma schema validation | Passed |
| Target database migration status | 13 migrations applied; current |
| Compiled backend startup and `/health` | Passed in development configuration |
| Compiled frontend startup and basic route responses | Passed |
| Tracked-secret scan | No actual committed credentials detected |
| Frontend lint | Failed: 359 errors, 341 warnings |
| Frontend automated tests | Not implemented |
| Browser E2E suite | Not implemented |
| Fresh-database migration | Not run |
| PayMongo external Test Mode checkout/webhook/refund | Not run; webhook secret missing |
| Fresh production dependency audit | Inconclusive; `npm audit` hung during the latest run |
| Load, penetration, and multi-instance tests | Not run |

## Rules for updating this tracker

1. A checkbox is completed only after implementation and proportionate verification pass.
2. Record the command, test case, or manual evidence in the commit or audit update.
3. Do not replace a failed or unexecuted test with a written claim of compliance.
4. Do not describe ServiceHub as production-ready until every Tier 0 release-gate item is complete.
5. Recalculate readiness after each phase rather than changing the percentage based only on code volume.
