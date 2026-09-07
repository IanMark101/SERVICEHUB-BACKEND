# ServiceHub Cordova Software Test Document

Last verified: September 7, 2026

## 1. Purpose and status language

This document records executed evidence for the supported ServiceHub Cordova capstone. It does not treat an implementation claim as a test result.

- **Passed**: the named automated command completed successfully in the current revision.
- **Failed**: the named test was executed and failed.
- **Not Run**: the feature exists, but the required external or interactive verification has not been executed.
- **Not Implemented**: the feature is outside the supported product or intentionally deferred.

The supported marketplace uses reusable listings and independent one-time bookings. Session scheduling, recurring contracts, real payouts, and Live Mode payments are not part of the defended Tier 0 product. `PAID_HELD`, `FROZEN_HELD`, and `RELEASED` are internal PayMongo Test Mode ledger states; they are not escrow or custody claims.

## 2. Executed automated evidence

| Area | Evidence | Result |
| --- | --- | --- |
| Backend compilation | `npm run build` | **Passed** |
| Backend contracts | `npm test` | **Passed — 23/23** |
| Flow A/Flow B, queue, completion, internal refund ledger | `npm run test:booking-integration` | **Passed — 1/1** |
| Queue concurrency and completion escalation | `npm run test:phase2-integration` | **Passed — 1/1** |
| Verification privacy, retention, and deletion blockers | `npm run test:phase3-integration` | **Passed — 1/1** |
| Reports, review moderation, promotion, final deactivation | `npm run test:phase4-integration` | **Passed — 1/1** |
| Listing limits, duplicate titles, material-edit moderation, repeat requests | `npm run test:phase5-integration` | **Passed — 1/1** |
| Signed webhook parsing and idempotency with mocked gateway retrieval | `npm run test:phase6-integration` | **Passed — 1/1** |
| Email/account restrictions and bilateral lifecycle resolution | `npm run test:phase7-integration` | **Passed — 1/1** |
| Concurrent messages and paginated notifications | `npm run test:phase7-load` | **Passed — 1/1** |
| Frontend unit/component tests | `npm test` | **Passed — 13/13** |
| Frontend static analysis | `npx tsc --noEmit` and `npm run lint` | **Passed — 0 errors, 0 warnings** |
| Frontend production compilation | `npm run build` | **Passed — 93 routes** |
| Frontend dependencies | `npm audit --omit=dev` and `npm audit` | **Passed — 0 vulnerabilities** |
| Backend dependencies | `npm audit --omit=dev` and `npm audit` | **Passed — 0 vulnerabilities** |
| Prisma schema | `npx prisma validate` | **Passed** |
| Fresh disposable schema | `npm run test:fresh-migrations` | **Passed — 19 migrations, 32 tables, zero drift, booking flow passed, schema removed** |
| Chromium E2E | `npm run test:e2e` | **Passed — UI password login plus four API-assisted browser lifecycle cases** |
| Configured target migration parity | `prisma migrate status` and `prisma migrate diff` | **Failed release gate — five migrations are unrecorded and three indexes/one default differ** |

All database-backed suites use uniquely named fixtures and delete those fixtures after execution. Gateway HTTP is mocked only where the test explicitly exercises signed webhook retrieval or a refund response; those tests do not prove PayMongo dashboard configuration.

## 3. Requirements verification matrix

| Requirement | Automated result | Interactive/browser result | Release status |
| --- | --- | --- | --- |
| Registration validation, password login, refresh rotation, logout | Contract/source tests cover gates; build passes | Password login and request-loop acceptance passed; registration/refresh/logout journey remains | **Not Run** as a complete end-to-end case |
| Google OAuth | Server fails closed when configuration is absent | Authorized origins cannot be verified without Google Cloud access | **Not Run** |
| Email and residency gates | Phase 3 and Phase 7 integration | Upload/admin review browser rehearsal pending | **Passed** backend; **Not Run** browser |
| Private verification documents and audited access | Phase 3 integration | Cloudinary delivery rehearsal pending | **Passed** backend; **Not Run** browser |
| Listing creation, three-listing limit, duplicate guard, admin moderation | Phase 5 integration | Provider/admin browser rehearsal pending | **Passed** backend; **Not Run** browser |
| Material listing edit returns to review and notifies parties | Phase 5 integration | Notification UI rehearsal pending | **Passed** backend; **Not Run** browser |
| Reusable listing / Request Again | Phase 5 and booking integration | Browser repeat-request rehearsal pending | **Passed** backend; **Not Run** browser |
| Flow A onsite cash | Booking integration covers request, provider response, start, completion, confirmation | API-assisted Chromium lifecycle passed | **Passed** |
| Flow A online payment | Attempt/finalization logic covered with controlled gateway data | Real PayMongo Test Mode checkout and webhook pending | **Not Run** externally |
| Flow B request, exact-listing offer, onsite cash | Booking/listing integrations cover exact offer and terminal request state | API-assisted Chromium lifecycle passed | **Passed** |
| Flow B online payment | Hold/failure/expiry/finalization logic covered | Real PayMongo Test Mode checkout and webhook pending | **Not Run** externally |
| Online-only FCFS queue and provider-global ongoing guard | Booking and Phase 2 concurrency suites | Multi-user browser rehearsal pending | **Passed** backend; **Not Run** browser |
| Waitlist and queue reindexing | Booking/Phase 2 suites | Browser presentation pending | **Passed** backend; **Not Run** browser |
| Before-start cancellation | Booking suite covers cash and mocked Test Mode refund records | API-assisted Chromium case passed | **Passed** for cash; external refund **Not Run** |
| After-start bilateral cancellation and escalation | Phase 7 integration covers both participant directions | API-assisted Chromium approval path passed; decline/escalate UI pending | **Not Run** as a complete browser matrix |
| Completion, 72-hour escalation, dispute, admin resolution | Booking, Phase 2, Phase 4, and Phase 7 integrations | API-assisted Chromium escalation/dispute/Admin audit case passed | **Passed** lifecycle; full UI rehearsal pending |
| Reviews and 24-hour edit policy | Contract/integration coverage | Browser interaction pending | **Passed** backend; **Not Run** browser |
| Helpful-review shared voting | Removed because it had no server-backed shared state | Not exposed | **Not Implemented** |
| Participant-only messaging and closed-thread behavior | Authorization and communication suites cover access/durability | Two-browser realtime rehearsal pending | **Passed** backend; **Not Run** browser |
| Conversation, notification, and transaction pagination | Backend pagination contracts/load assertions; frontend build/lint pass | Browser load-more rehearsal pending | **Passed** code; **Not Run** browser |
| Admin overview, moderation, audit, and reconciliation | Contract and Phase 4/5/7 suites | Complete admin browser rehearsal pending | **Passed** backend; **Not Run** browser |
| AI review digest | Deterministic fallback/caching implementation builds | Live Gemini response requires key and five eligible reviews | **Not Run** externally |
| AI provider matching | Optional Tier 2 surface | Not part of the primary defense | **Not Implemented** for release gate |
| Session scheduling / recurring services | Removed from supported UI/API; legacy enum values retained for compatibility | Not exposed | **Not Implemented** by design |
| Real payout, escrow, withdrawal, commission, Live Mode | Explicitly outside this capstone | Not exposed | **Not Implemented** by design |

## 4. Security cases with executable coverage

The current automated suites verify missing-token 401 behavior for every protected Tier 0 HTTP route, administrator/marketplace role separation, participant ownership, self-transaction rejection, duplicate booking/payment/webhook/dispute handling, action-specific rate-limit wiring, raw-body webhook signature use, exact payment metadata validation, server-owned prices, private evidence authorization, restricted-account resolution access, final-deletion blockers, one-provider-one-ongoing-job enforcement, and audited administrator decisions.

The following are not represented as passed until they are performed: independent penetration testing, multi-instance Socket.io/rate-limit behavior, a production CSP rollout, disaster-restore timing, browser console/network acceptance, and external OAuth/PayMongo configuration.

## 5. Final interactive defense checklist

Use labelled demonstration accounts and retain screenshots plus browser/server logs.

1. Password login as Seeker, Provider, and Admin; switch workspaces and log out.
2. Submit and moderate a residency document; verify the user-visible decision note.
3. Create, edit, approve, reject, and locate a listing from the admin overview card.
4. Complete Flow A onsite cash from request through bilateral reviews, then Request Again.
5. Complete Flow B onsite cash from public request through exact offer and terminal request state.
6. Exercise before-start cancellation, after-start approve/decline/escalate, completion escalation, dispute, and administrator resolution.
7. Exchange realtime messages and notifications between two browsers; confirm pagination/load-more controls and closed-thread behavior.
8. After external configuration is available, execute one Flow A and one Flow B PayMongo Test Mode checkout, replay a webhook, and reconcile one Test Mode refund.
9. After Google Cloud access is available, verify every deployed/local authorized JavaScript origin and complete logout/login OAuth.
10. Confirm browser and server logs contain no unexplained request loops, 4xx/5xx responses, duplicate listeners, or unhandled rejections.

## 6. Release interpretation

The automated repository evidence is strong enough for continued capstone development and a cash-flow defense rehearsal. The entire system is **not yet production-ready**: the populated target database migration mismatch, browser defense rehearsal, Google authorized-origin validation, and real PayMongo Test Mode checkout/webhook evidence remain open. See `CAPSTONE_READINESS_TRACKER.md` and `RELEASE_OPERATIONS.md` for the authoritative release gate and recovery procedures.
