# ServiceHub Cordova Security Re-audit

Last verified: September 7, 2026
Scope: supported one-time Flow A/Flow B marketplace, authentication, verification privacy, Admin operations, PayMongo Test Mode ledger, queue/completion/cancellation/dispute lifecycle, notifications, messaging, and release operations.

## Decision

No unresolved critical repository vulnerability was found in the executed automated pass. The repository is suitable for continued capstone development and a controlled onsite-cash defense rehearsal. It is **not approved as production-ready** because target migration drift, complete browser rehearsal, Google OAuth origin validation, real PayMongo Test Mode checkout/webhook evidence, multi-instance reliability, and independent penetration testing remain open.

This assessment does not approve Live Mode or real-money custody. `PAID_HELD`, `FROZEN_HELD`, `RELEASED`, balances, and refund states are internal Test Mode records—not escrow, payout, wallet, or regulated-custody guarantees.

## Executed evidence

| Check | Current result |
| --- | --- |
| Backend TypeScript build | Passed |
| Backend contract tests | 23/23 passed |
| Database-backed integration/load suites | 8/8 commands passed; each suite reports 1/1 |
| Frontend TypeScript | Passed |
| Frontend ESLint | Passed with 0 errors and 0 warnings |
| Frontend component/unit tests | 13/13 passed |
| Frontend production build | Passed; 93 routes |
| Backend production/development dependency audit | 0 vulnerabilities |
| Frontend production/development dependency audit | 0 vulnerabilities |
| Prisma schema validation | Passed |
| Configured target migration status | Failed release gate: five migrations not recorded |
| Configured target schema diff | Failed release gate: AI summary default and three queue/booking indexes differ |
| PayMongo signed-webhook logic | Passed with controlled test events; external delivery not run |
| Browser E2E/console acceptance | Not run as a complete defense matrix |

## Controls verified by executable tests

### Identity, authorization, and sessions

- Protected Tier 0 routes return 401 without a bearer token before protected data is queried.
- Administrator accounts and marketplace users are separated by role guards.
- New marketplace relationships require verified email and approved residency; restricted users retain narrowly scoped resolution access so funds and disputes are not stranded.
- Refresh tokens, email-verification tokens, and password-reset tokens are stored as hashes; refresh sessions rotate and can be revoked.
- Trusted-origin checks protect cookie-backed refresh/logout mutations.
- Google login fails closed when the backend client ID is absent or invalid.

### Marketplace and payment integrity

- Server-owned listing/offer prices determine payment amounts; clients cannot supply a trusted final price.
- Self-transactions, duplicate active requests, duplicate bookings, duplicate webhook events, duplicate disputes, and duplicate completion credits are rejected or idempotent.
- Flow A and Flow B bind provider, seeker, listing, offer, amount, currency, and payment method before finalization.
- Onsite cash creates no Queue row and no online transaction credit. Online Test Mode finalization creates one not-started Booking and one FCFS Queue row.
- Payment failure/expiry releases Flow B holds. Post-capture capacity/eligibility loss creates an explicit `REFUND_REQUIRED` reconciliation state instead of silently losing value.
- A provider may have only one ongoing one-time Booking across listings; queue start is transactionally guarded.
- Before-start and after-start cancellation, completion, escalation, dispute, refund records, and administrator decisions are durable and idempotent in the covered cases.

### Privacy, messaging, and administration

- Verification proofs and report evidence use private managed references and audited, authorization-checked access.
- Account deletion is blocked by active/held lifecycle records; finalization revokes sessions and records the administrator action.
- Message access is participant-only; closed threads remain historical/read-only and per-user hiding does not delete the evidence.
- Notification and message concurrency tests verify durable records, bounded/paginated responses, and idempotent read operations.
- Listing material edits return the item to hidden review and create durable provider/administrator notifications.
- Admin listing counts use the public marketplace predicate; service inventory, reports, completion escalations, payment attempts, and reconciliation use database-backed endpoints.
- High-impact auth, message, review, report, payment, and waitlist mutations have dedicated rate-limit wiring with IPv6-safe keys.
- API responses carry request IDs and baseline security headers; production errors return safe context rather than raw stack traces.

## Open release risks

### Must be resolved before a production-ready claim

1. **Configured database mismatch.** Five migrations are not recorded, and the target lacks three indexes plus the intended AI-summary default. The pending migrations were inspected, but applying them was not authorized because the final migration normalizes legacy session values. Create a backup and obtain explicit owner approval before `prisma migrate deploy`.
2. **Browser defense matrix.** Record password login/logout, verification, Admin moderation, both cash marketplace flows, cancellation directions, completion/escalation/dispute, two-browser realtime messaging/notifications, pagination, and clean browser/server logs.
3. **Google OAuth.** Verify the exact local/deployed authorized JavaScript origins in the project-owned Google Cloud OAuth client.
4. **PayMongo Test Mode.** Configure a stable public HTTPS webhook and signing secret, then execute one Flow A and one Flow B checkout, replay verification, and one audited refund/reconciliation.
5. **Deployment resilience.** A multi-instance deployment needs shared rate limiting, a shared Socket.io adapter, and a durable notification/outbox retry path.
6. **Independent assurance.** Perform penetration testing, restore timing, and operational monitoring acceptance in the intended hosting environment.

### Intentionally unsupported

- Real provider payouts, withdrawals, commissions, subscriptions, Live Mode payments, and escrow/custody claims.
- Session-based scheduling, calendar reservations, recurring contracts, and automatic recurring charges.
- Shared helpful-review voting and optional AI matching as release-critical features.

Legacy `SESSION_BASED`, `PER_SESSION`, `scheduledDate`, and `scheduledTime` database fields remain only for compatibility. The supported API/UI creates reusable `ONE_TIME` listings; each repeat request creates a separate Booking with independent payment, chat, completion, and review history.

## Operational requirements

- Follow `RELEASE_OPERATIONS.md` for backup, migration, restore, rollback, webhook recovery, log review, and known limitations.
- Follow `SOFTWARE_TEST_DOCUMENT.md` for status definitions and the final interactive defense checklist.
- Never commit `.env`, private proof assets, access/refresh tokens, SMTP credentials, Cloudinary secrets, PayMongo secrets, webhook secrets, Gemini keys, or Google client secrets.
- Treat socket events as hints; database records remain authoritative.
- Do not change a Not Run result to Passed based only on source inspection.

## Conclusion

The automated repository posture is materially stronger than the prior audit: builds, lint, contracts, integration/load suites, and dependency audits are green, and earlier misleading payment/session claims have been removed. The remaining blockers are explicit and auditable. ServiceHub Cordova may proceed as a capstone release candidate only after the database, browser, and external-configuration gates above are completed; it must not yet be described as fully production-ready.
