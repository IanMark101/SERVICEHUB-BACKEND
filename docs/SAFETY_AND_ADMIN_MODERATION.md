# Safety and Administrator Moderation Policy

Last updated: October 4, 2026

This document defines the implemented Tier 0 rules for booking safety reports,
review moderation, administrator provisioning, and final account deactivation.

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

## Administrator provisioning

- User Management has no Make Admin action or promotion dialog, and the API has
  no administrator-promotion endpoint.
- Authorized database maintainers manage the existing `user` and `admin` roles
  directly. Public signup and OAuth cannot assign administrator access.
- Before a database role change, resolve active bookings, held payments, and
  unresolved cases, record the reason in the administrator audit log, and revoke
  the target's sessions. Preserve historical marketplace records.

## Self-service account deletion

- Account Settings shows a checklist for published service listings, open
  requests, unfinished bookings and queue jobs, payments and refunds, and
  unresolved moderation cases. Users pause listings in Service Manager and
  pause or close requests in Request Manager before continuing.
- The owner types `DELETE`, then verifies their current password or completes
  a fresh Google verification bound to that account and authenticated session.
  An existing signed-in session alone cannot authorize deletion.
- Eligibility is checked again inside the account lifecycle transaction. New
  bookings, publication, payments, or cases cannot bypass this check. Blocked
  deletion returns the updated checklist without changing account state.
- Successful deletion physically removes the User row and associated database
  content, credentials, verification records, closed bookings, payments, chats,
  reviews, cases, audit/trust history, caches, and old deletion receipts. It
  revokes every session and disconnects sockets. No placeholder row remains.
- Shared closed-booking history is removed for both participants; unrelated
  accounts and engagements remain. This consequence is shown before confirmation.
  Explicit document holds and retryable case-resolution operations still block
  deletion. SQL deletion does not erase external storage files or backups. See
  [Verification document retention](VERIFICATION_DOCUMENT_RETENTION.md).

## Administrator collection limits

Administrator queues and history endpoints use page/limit parameters with a
server-side maximum. This includes announcements, users, verification requests,
service and category review queues, reports, reviews, completion escalations,
payment reconciliation, bookings, payment attempts, escalated cancellations,
and audit logs. Overview widgets are intentionally
bounded summaries.
