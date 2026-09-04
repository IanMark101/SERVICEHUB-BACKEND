-- ServiceHub v2.2 payment, queue, completion, and dispute hardening.
-- This migration is additive. Legacy offers keep a NULL serviceId and are
-- rejected by new booking/payment paths until an administrator remediates them.

ALTER TYPE "RequestStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_PENDING';
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CASH_CONFIRMED';

CREATE TYPE "PaymentAttemptStatus" AS ENUM (
  'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUND_REQUIRED', 'REFUNDED'
);
CREATE TYPE "ProcessedWebhookStatus" AS ENUM ('PROCESSING', 'PROCESSED', 'FAILED');
CREATE TYPE "BookingOriginType" AS ENUM ('DIRECT_LISTING', 'OFFER');

ALTER TABLE "offers"
  ADD COLUMN "serviceId" TEXT,
  ADD COLUMN "paymentHoldExpiresAt" TIMESTAMP(3);

ALTER TABLE "bookings"
  ADD COLUMN "originType" "BookingOriginType",
  ADD COLUMN "paymentAttemptId" TEXT,
  ADD COLUMN "statusBeforeDispute" "BookingStatus";

CREATE UNIQUE INDEX "bookings_paymentAttemptId_key" ON "bookings"("paymentAttemptId");

ALTER TABLE "reports" ADD COLUMN "reportType" TEXT NOT NULL DEFAULT 'SAFETY';
ALTER TABLE "transactions"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "settlementSource" TEXT;
CREATE UNIQUE INDEX "transactions_idempotencyKey_key" ON "transactions"("idempotencyKey");

ALTER TABLE "trust_score_events" ADD COLUMN "eventKey" TEXT;
CREATE UNIQUE INDEX "trust_score_events_eventKey_key" ON "trust_score_events"("eventKey");

ALTER TABLE "payment_refunds" ALTER COLUMN "bookingId" DROP NOT NULL;
ALTER TABLE "payment_refunds" ADD COLUMN "paymentAttemptId" TEXT;
CREATE UNIQUE INDEX "payment_refunds_paymentAttemptId_key" ON "payment_refunds"("paymentAttemptId");

CREATE TABLE "payment_attempts" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "seekerId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  "offerId" TEXT,
  "providerIntentId" TEXT,
  "providerPaymentId" TEXT,
  "providerClientKey" TEXT,
  "redirectUrl" TEXT,
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PHP',
  "paymentMethod" TEXT NOT NULL,
  "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "failureReason" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_attempts_idempotencyKey_key" ON "payment_attempts"("idempotencyKey");
CREATE UNIQUE INDEX "payment_attempts_providerIntentId_key" ON "payment_attempts"("providerIntentId");
CREATE UNIQUE INDEX "payment_attempts_providerPaymentId_key" ON "payment_attempts"("providerPaymentId");
CREATE INDEX "payment_attempts_seekerId_serviceId_status_idx" ON "payment_attempts"("seekerId", "serviceId", "status");
CREATE INDEX "payment_attempts_offerId_status_idx" ON "payment_attempts"("offerId", "status");
CREATE UNIQUE INDEX "payment_attempts_active_target_key"
  ON "payment_attempts" ("seekerId", "serviceId", COALESCE("offerId", ''))
  WHERE "status" = 'PENDING';

CREATE TABLE "processed_webhook_events" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" "ProcessedWebhookStatus" NOT NULL DEFAULT 'PROCESSING',
  "failureReason" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "processed_webhook_events_provider_eventId_key" ON "processed_webhook_events"("provider", "eventId");
CREATE INDEX "processed_webhook_events_status_createdAt_idx" ON "processed_webhook_events"("status", "createdAt");

CREATE TABLE "completion_escalations" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "adminId" TEXT,
  "resolution" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "completion_escalations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "completion_escalations_bookingId_status_idx" ON "completion_escalations"("bookingId", "status");
CREATE INDEX "completion_escalations_status_createdAt_idx" ON "completion_escalations"("status", "createdAt");

-- Prevent duplicate bilateral reviews going forward. The application already
-- treats one review per author per completed engagement as the valid contract.
CREATE UNIQUE INDEX "reviews_completedServiceId_authorId_key"
  ON "reviews"("completedServiceId", "authorId");

-- One unresolved completion dispute per reporter and booking. Safety reports
-- remain independent records.
CREATE UNIQUE INDEX "reports_open_completion_dispute_key"
  ON "reports"("bookingId", "reporterId")
  WHERE "reportType" = 'COMPLETION_DISPUTE' AND "status" IN ('PENDING', 'UNDER_REVIEW');
