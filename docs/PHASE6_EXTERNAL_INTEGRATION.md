# Phase 6 external integration status

Updated September 5, 2026.

Status: external configuration deferred by the project owner. Local automated
work is complete enough to continue with Phase 7, but Phase 6 is not complete.
Do not interpret the deferred items as passing evidence.

## Verified local configuration

- Backend and frontend Google client IDs are present and match. Authorized
  JavaScript origins still require verification in the project-owned Google
  Cloud Console.
- PayMongo public and secret keys are present and use `pk_test_` / `sk_test_`.
- `PAYMONGO_WEBHOOK_SECRET` is not configured. Online initiation remains
  intentionally unavailable until a signed public webhook can be received.
- Production validation reports each missing PayMongo field separately.

No secret values are recorded in this document or committed to source control.

## Verified payment behavior

The signed local webhook replay exercises the real Express controller boundary
with a raw request body and HMAC signature. Provider retrieval is mocked, while
database fulfillment is real. Delivering the same successful event twice
produces one `ProcessedWebhookEvent`, one successful `PaymentAttempt`, one
`Booking`, and one `Queue` row.

The booking integration suite also verifies:

- failed and expired Flow B holds return the Offer to `PENDING` and the request
  to `OPEN`, without creating a Booking;
- capacity loss after capture produces no Booking and records
  `REFUND_REQUIRED`;
- cancellation/refund retries create one refund and one ledger transaction.

## Test Mode refund policy

PayMongo's current refund documentation states that only live transactions can
be refunded. ServiceHub is intentionally Test Mode-only for the capstone, so
the application records an idempotent `SIMULATED_TEST_MODE` reversal and marks
its internal booking/payment ledger `REFUNDED`. It does not call the PayMongo
refund endpoint or claim money moved. A real provider refund is outside the
capstone and requires a future Live Mode review.

Reference: https://developers.paymongo.com/v1/docs/refunding-transactions

## Remaining manual external work

1. Expose `POST /api/payments/paymongo/webhook` through a stable public HTTPS
   deployment or tunnel.
2. Register one Test Mode webhook for the successful and failed payment events
   handled by the application; do not create one webhook per payment.
3. Store its signing secret as `PAYMONGO_WEBHOOK_SECRET` only in the backend
   environment, restart, and verify the health/configuration checks.
4. Complete one Flow A and one Flow B Test Mode checkout and retain redacted
   event IDs plus database screenshots as defense evidence.
5. Verify `http://localhost:3000` and the deployed frontend URL are Authorized
   JavaScript origins for the matching Google web client, then retest logout and
   login in a fresh browser profile.

PayMongo documents webhook delivery retries and requires a successful 2xx
response. The handler is therefore signature-verified and idempotent by event
ID before applying business effects.

Webhook reference: https://developers.paymongo.com/v1/docs/accepting-grabpay-payments

## Known dependency warning

The database-backed lifecycle test passes but Prisma 7.10's `adapter-pg` emits
the node-postgres overlapping-query deprecation warning for some relational
writes. A traced stack points into Prisma's query interpreter rather than
ServiceHub application code. This is an open upstream adapter issue and must be
retested before adopting node-postgres 9; suppressing or pinning an old driver
would only hide the compatibility risk.

Upstream references:

- https://github.com/prisma/prisma/issues/29646
- https://github.com/prisma/prisma/issues/29407
