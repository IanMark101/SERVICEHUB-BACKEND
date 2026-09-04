# ServiceHub Cordova Capstone Readiness Tracker

Last audited: September 4, 2026

Authoritative specification: `SERVICEHUB_MASTER_PROMPT.md` Version 2.2

Working branch: `fix/admin-security-hardening`

Current estimated capstone readiness: **70%**

## Readiness summary

| Area | Readiness | Current assessment |
| --- | ---: | --- |
| Core marketplace flows | 82% | Flow A and Flow B cash paths work; online paths need external verification |
| Authentication and session security | 80% | Strong token/session design; privacy and moderation boundaries remain |
| Payment and queue integrity | 72% | Sequential tests pass; concurrent queue integrity is not yet guaranteed |
| Admin operations | 72% | Major panels work; important safeguards and auditing remain |
| Messaging, realtime, and notifications | 78% | Functional; pagination, durability, and request fan-out need polish |
| Reviews, trust, community, and AI | 68% | Functional foundation; aggregate correctness and AI eligibility need fixes |
| UX and code quality | 60% | Builds pass; lint, placeholder actions, terminology, and large files remain |
| Testing and deployment readiness | 48% | Backend integration exists; frontend E2E, load, and security automation do not |

Additional estimates:

- Onsite-cash demonstration readiness: **85%**
- Full capstone defense readiness: **70%**
- Real production readiness: **45%**

## Completion order

Work through these phases in order. Do not mark an item complete until the associated implementation and verification evidence both exist.

### Phase 1 â€” establish a reproducible baseline â€” **IN PROGRESS**

- [x] Review and group the existing backend source changes. **DONE — security/payment/queue hardening, controller/service refactor, migrations, and executable tests reviewed as one baseline.**
- [x] Review and group the existing frontend source changes. **DONE — component/hook refactor, auth/session handling, Admin flows, payment wording, and help content reviewed as one baseline.**
- [x] Stop tracking generated backend `dist` files and confirm production builds regenerate them correctly. **DONE — `/dist` is ignored, tracked count is zero, and `npm run build` recreated `dist/src/server.js` successfully.**
- [x] Commit the intended backend changes on `fix/admin-security-hardening`. **DONE — baseline commit `dcb0b9d`.**
- [x] Commit the intended frontend changes on `fix/admin-security-hardening`. **DONE — baseline commit `dc46ef0`.**
- [ ] Push both branches and verify the remote branch contains the current implementation.
- [ ] Confirm both working trees are clean after builds, excluding deliberately ignored output.

### Phase 2 â€” queue and lifecycle concurrency â€” **NOT STARTED**

- [ ] Move queue recalculation into the same transaction and service lock as payment, start, completion, cancellation, and removal mutations.
- [ ] Add database protection for positive and unique active queue positions where practical.
- [ ] Make QueueNotify capacity checks and notification consumption atomic and idempotent.
- [ ] Add concurrent tests for payment finalization, queue insertion, cancellation, completion, reindexing, and Start Job.
- [ ] Correct CompletionEscalation retry cooldown from 24 hours to 72 hours.
- [ ] Return the existing active CompletionEscalation for duplicate requests instead of creating another record or returning an ambiguous conflict.
- [ ] Add durable administrator notification when a completion escalation is created.
- [ ] Test the 72-hour initial threshold, duplicate behavior, `KEEP_AWAITING`, and second 72-hour threshold.

### Phase 3 â€” privacy, verification, and deletion â€” **NOT STARTED**

- [ ] Require verified email before residency-document upload and submission.
- [ ] Add a versioned privacy notice and required acknowledgement checkbox.
- [ ] Store privacy-notice version, acknowledgement timestamp, and user identity with each verification submission.
- [ ] Redact internal verification `storageKey` values from ordinary responses.
- [ ] Record an immutable AdminAuditLog entry whenever an administrator views or downloads a private document.
- [ ] Define document retention periods and legal/active-case holds.
- [ ] Implement a real account-deletion request endpoint and status model.
- [ ] Block final deletion while nonterminal bookings, held payments, cancellations, reports, or escalations remain.
- [ ] Replace the frontend's simulated account-deletion alert with the real workflow.
- [ ] Correct the deletion UI so it does not promise removal of legally retained transaction/audit records.

### Phase 4 â€” safety, moderation, and administrator safeguards â€” **NOT STARTED**

- [ ] Add a general booking-participant safety-report endpoint.
- [ ] Allow either participant to report the other from documented eligible booking states.
- [ ] Store evidence through private, booking-authorized storage.
- [ ] Deduplicate active reports for the same booking/reporter/type.
- [ ] Add review visibility/moderation state.
- [ ] Add administrator review-hide/restore actions with reason and immutable audit log.
- [ ] Require current-administrator password reauthentication before promoting another administrator.
- [ ] Block administrator promotion when the target has active bookings, held payments, or unresolved cases.
- [ ] Implement guarded final account deactivation.
- [ ] Add a paginated administrator audit-log API and dashboard view.
- [ ] Paginate escalated cancellations, announcements, reconciliation results, and other remaining unbounded administrator lists.

### Phase 5 â€” listing, review, trust, and AI correctness â€” **NOT STARTED**

- [ ] Return an approved listing to `PENDING_REVIEW` after material description, media, proof, title, or category edits.
- [ ] Enforce the three-listing maximum transactionally under concurrent creation.
- [ ] Implement normalized, active-only duplicate-title protection while allowing safe title reuse after deletion.
- [ ] Align listing title and description minimum lengths with the Master Prompt.
- [ ] Do not store an authoritative direct-booking price for `CUSTOM` listings.
- [ ] Require at least one payment method during listing updates.
- [ ] Align Card, GCash, Maya, and onsite-cash support between listing configuration and booking/payment APIs.
- [ ] Make advanced price types usable only through an exact provider Offer in both UI and API.
- [ ] Replace the fake `cert_uploaded.jpg` skill proof with managed storage or remove the field.
- [ ] Restrict provider rating, ranking, and AI aggregates to eligible reviews where the target participated as provider.
- [ ] Keep seeker-role reviews in profile history without affecting provider metrics.
- [ ] Route every trust change through one transactional trust service.
- [ ] Give every business trust event a unique idempotency key.
- [ ] Stop exposing another user's exact private trust-event history.
- [ ] Require five eligible written provider reviews before calling Gemini.
- [ ] Persist/cache summaries by provider and review-content version or clearly document an intentional cache strategy.
- [ ] Add defense seed data with five valid completed bookings and eligible written reviews.
- [ ] Replace hardcoded named landing testimonials with real seed data or clearly labelled demonstration content.

### Phase 6 â€” PayMongo Test Mode and external integration â€” **NOT STARTED**

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

### Phase 7 â€” automated test coverage â€” **NOT STARTED**

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

### Phase 8 â€” UI, performance, and code-quality polish â€” **NOT STARTED**

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
- [ ] Finish splitting the remaining 400â€“530-line frontend components and hooks by feature responsibility.
- [ ] Remove or gate unnecessary production console logging.

### Phase 9 â€” documentation and final release gate â€” **NOT STARTED**

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
| Frontend production build | Passed; 90 routes generated |
| Backend production build | Passed |
| Backend contract tests | 14/14 passed |
| Database-backed booking/payment/queue integration | 1/1 passed |
| Prisma schema validation | Passed |
| Target database migration status | 10 migrations applied; current |
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
