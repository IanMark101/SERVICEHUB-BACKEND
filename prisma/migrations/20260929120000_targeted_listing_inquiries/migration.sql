ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "targetProviderId" TEXT;
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "targetServiceId" TEXT;
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "preferredPaymentMethod" TEXT;

CREATE INDEX IF NOT EXISTS "service_requests_targetProviderId_status_idx" ON "service_requests"("targetProviderId", "status");
CREATE INDEX IF NOT EXISTS "service_requests_seekerId_targetServiceId_status_idx" ON "service_requests"("seekerId", "targetServiceId", "status");

ALTER TABLE "payment_attempts" ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "direct_requests" ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1;
