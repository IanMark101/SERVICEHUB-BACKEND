CREATE TYPE "AccountModerationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED');

ALTER TABLE "users"
  ADD COLUMN "moderationStatus" "AccountModerationStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "suspendedUntil" TIMESTAMP(3),
  ADD COLUMN "moderationReason" TEXT,
  ADD COLUMN "postingSuspended" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "postingSuspendedAt" TIMESTAMP(3),
  ADD COLUMN "postingSuspendReason" TEXT;

UPDATE "users" SET "moderationStatus" = 'SUSPENDED' WHERE "isActive" = false;

ALTER TABLE "categories_suggested"
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "adminNotes" TEXT;

ALTER TABLE "services"
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "trust_score_events" ADD COLUMN "actorAdminId" TEXT;
ALTER TABLE "cancellation_requests" ADD COLUMN "adminId" TEXT;
ALTER TABLE "queue" ADD COLUMN "paymongoPaymentId" TEXT;
ALTER TABLE "verification_proofs"
  ALTER COLUMN "fileUrl" DROP NOT NULL,
  ADD COLUMN "storageKey" TEXT,
  ADD COLUMN "mimeType" TEXT,
  ADD COLUMN "sizeBytes" INTEGER;

CREATE TABLE "admin_audit_logs" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "targetUserId" TEXT,
  "action" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT,
  "reason" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_refunds" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "paymongoRefundId" TEXT,
  "amount" DECIMAL(10,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_actorId_createdAt_idx" ON "admin_audit_logs"("actorId", "createdAt");
CREATE INDEX "admin_audit_logs_targetUserId_createdAt_idx" ON "admin_audit_logs"("targetUserId", "createdAt");
CREATE INDEX "admin_audit_logs_resourceType_resourceId_idx" ON "admin_audit_logs"("resourceType", "resourceId");
CREATE UNIQUE INDEX "payment_refunds_bookingId_key" ON "payment_refunds"("bookingId");
CREATE UNIQUE INDEX "payment_refunds_paymentId_key" ON "payment_refunds"("paymentId");
CREATE UNIQUE INDEX "payment_refunds_paymongoRefundId_key" ON "payment_refunds"("paymongoRefundId");
CREATE UNIQUE INDEX "queue_paymongoPaymentId_key" ON "queue"("paymongoPaymentId");
CREATE INDEX "payment_refunds_status_createdAt_idx" ON "payment_refunds"("status", "createdAt");

ALTER TABLE "categories_suggested" ADD CONSTRAINT "categories_suggested_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trust_score_events" ADD CONSTRAINT "trust_score_events_actorAdminId_fkey"
  FOREIGN KEY ("actorAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
