# Phase 7 automated coverage map

Last updated: September 6, 2026

This map links the Master Prompt's Tier 0 authorization and retry invariants to executable evidence. It does not treat browser-only or externally configured scenarios as passed.

## Authorization and ownership

| Requirement | Executable evidence |
| --- | --- |
| Every protected Tier 0 HTTP route rejects missing authentication with the standard `401` envelope; role/permission denial is `403` | `http-authorization.test.ts`, `authorization-contracts.test.ts`, `admin-contracts.test.ts` |
| Admin routes reject standard users and marketplace routes reject admins | `admin-contracts.test.ts`, `authorization-contracts.test.ts` |
| New marketplace relationships require verified email, approved residency, and an eligible account | `authorization-contracts.test.ts`, `authorization-lifecycle.test.ts`, `privacy-deletion.test.ts` |
| Restricted accounts retain narrow existing-obligation resolution access | `authorization-lifecycle.test.ts` |
| Suspended providers cannot accept or start new work | `authorization-lifecycle.test.ts` |
| Only booking participants can report, message, cancel, confirm, dispute, or access evidence | `safety-admin-guards.test.ts`, `authorization-lifecycle.test.ts`, service ownership checks exercised by the booking suites |
| Private verification and evidence access is ownership/admin controlled and audited | `privacy-deletion.test.ts`, `safety-admin-guards.test.ts` |
| Trust history and administrator decisions remain role restricted | `listing-correctness.test.ts`, `safety-admin-guards.test.ts` |

## Duplicate and retry safety

| Retry/duplicate invariant | Executable evidence |
| --- | --- |
| Payment finalization and signed webhook delivery create one payment/booking/queue result | `queue-concurrency.test.ts`, `payment-webhook.test.ts`, `booking-flows.test.ts` |
| Queue insertion, reindexing, Start Job, and service/provider capacity remain unique under contention | `queue-concurrency.test.ts` |
| Cancellation, refund/reversal, completion, and settlement retries do not duplicate financial or terminal state | `booking-flows.test.ts`, `authorization-lifecycle.test.ts` |
| One active CompletionEscalation; duplicate request returns the existing record; 72-hour cooldown enforced | `queue-concurrency.test.ts` |
| One unresolved completion dispute per booking | `authorization-lifecycle.test.ts` |
| Identical active safety reports deduplicate without blocking distinct incidents | `safety-admin-guards.test.ts` |
| One normalized active listing title and no more than three active listings under concurrent creation | `listing-correctness.test.ts` |
| Trust events and review-driven AI summaries are idempotent/versioned | `listing-correctness.test.ts` |

## Volume and durability

- `queue-concurrency.test.ts` covers queue and webhook races.
- `communication-concurrency.test.ts` covers simultaneous message persistence, notification durability, idempotent read operations, and the bounded notification response.
- Browser E2E is still open. Online checkout cases also depend on the deferred Phase 6 external configuration.
