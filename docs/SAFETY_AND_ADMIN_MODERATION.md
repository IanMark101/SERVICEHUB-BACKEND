# Safety and Administrator Moderation Policy

Last updated: September 4, 2026

This document defines the implemented Tier 0 rules for booking safety reports,
review moderation, administrator promotion, and final account deactivation.

## Booking safety reports

- Only the seeker or provider assigned to a booking may create a safety report.
- Either participant reports the other participant; a caller cannot choose an
  unrelated target or report themselves through this endpoint.
- Reports are accepted while the booking is `ACCEPTED`, `ONGOING`,
  `AWAITING_CONFIRMATION`, `UNDER_REVIEW`, `DISPUTED`, `COMPLETED`, or
  `CANCELED`. Pre-acceptance and unrelated records are not eligible.
- At most one active `SAFETY` report exists for the same booking and reporter.
  A retry returns the existing `PENDING` or `UNDER_REVIEW` report.
- Creating a report freezes a held online payment and moves an active booking
  into dispute review. It does not represent a completed refund or payout.

## Private evidence

- Evidence uploads are limited to authenticated booking participants and the
  same eligible booking states as safety-report creation.
- Images are stored as authenticated Cloudinary assets under a booking- and
  user-scoped storage key. Public asset URLs and internal storage keys are not
  returned in ordinary report responses.
- A report may reference only evidence stored for that booking by its reporter.
- An administrator receives a short-lived signed view or download URL through
  the dedicated evidence-access endpoint. Each issuance creates an immutable
  `AdminAuditLog` event.

## Review moderation

- New reviews are `VISIBLE` by default.
- Public provider-review results include only `VISIBLE` reviews.
- An administrator may `hide` or `restore` a review only with a recorded reason.
- The moderation state, administrator, timestamp, and reason are retained on the
  review, and each action creates a separate immutable audit event.

## Administrator promotion

- Promotion requires the acting administrator's current password. The password
  is checked against that administrator's stored password hash and is never
  written to an audit record.
- The target must be an active non-administrator and must have no nonterminal
  booking, held payment, active cancellation, active report, or active completion
  escalation.
- Successful promotion creates an administrator audit event.

## Final account deactivation

- Final deactivation is available only for a persisted pending deletion request
  and cannot target an administrator.
- Active marketplace and case blockers are recalculated inside the guarded
  transaction. If any exist, the request becomes `BLOCKED` and no account state
  is changed.
- A clear request deactivates the account, records `deactivatedAt`, revokes all
  refresh sessions, completes the deletion request, writes an administrator
  audit event, and disconnects active sockets.
- Transaction, moderation, and audit records subject to retention are preserved;
  deactivation is not presented as immediate physical erasure.

## Administrator collection limits

Administrator queues and history endpoints use page/limit parameters with a
server-side maximum. This includes announcements, users, verification requests,
service and category review queues, reports, reviews, completion escalations,
payment reconciliation, bookings, payment attempts, escalated cancellations,
account-deletion requests, and audit logs. Overview widgets are intentionally
bounded summaries.
