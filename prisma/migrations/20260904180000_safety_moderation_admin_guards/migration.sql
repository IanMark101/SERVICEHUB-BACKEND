CREATE TYPE "ReviewVisibility" AS ENUM ('VISIBLE', 'HIDDEN');

ALTER TABLE "users" ADD COLUMN "deactivatedAt" TIMESTAMP(3);

ALTER TABLE "reviews"
  ADD COLUMN "visibility" "ReviewVisibility" NOT NULL DEFAULT 'VISIBLE',
  ADD COLUMN "moderationReason" TEXT,
  ADD COLUMN "moderatedById" TEXT,
  ADD COLUMN "moderatedAt" TIMESTAMP(3);

ALTER TABLE "reports" ADD COLUMN "evidenceStorageKey" TEXT;

CREATE INDEX "reviews_visibility_createdAt_idx" ON "reviews"("visibility", "createdAt");

CREATE UNIQUE INDEX "reports_one_active_type_per_reporter_key"
  ON "reports"("bookingId", "reporterId", "reportType")
  WHERE "status" IN ('PENDING', 'UNDER_REVIEW');
