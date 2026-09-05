CREATE TYPE "AccountDeletionStatus" AS ENUM ('PENDING', 'BLOCKED', 'CANCELLED', 'COMPLETED');

ALTER TABLE "service_verifications"
  ADD COLUMN "privacyNoticeVersion" TEXT,
  ADD COLUMN "privacyAcknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "privacyAcknowledgedBy" TEXT,
  ADD COLUMN "retentionUntil" TIMESTAMP(3),
  ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;

UPDATE "service_verifications"
SET
  "privacyNoticeVersion" = 'legacy-pre-v1',
  "privacyAcknowledgedAt" = "submittedAt",
  "privacyAcknowledgedBy" = "userId",
  "retentionUntil" = GREATEST("submittedAt", COALESCE("reviewedAt", "submittedAt")) + INTERVAL '365 days';

ALTER TABLE "service_verifications"
  ALTER COLUMN "privacyNoticeVersion" SET NOT NULL,
  ALTER COLUMN "privacyAcknowledgedAt" SET NOT NULL,
  ALTER COLUMN "privacyAcknowledgedBy" SET NOT NULL,
  ALTER COLUMN "retentionUntil" SET NOT NULL;

CREATE TABLE "account_deletion_requests" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "AccountDeletionStatus" NOT NULL DEFAULT 'PENDING',
  "blockers" JSONB,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_deletion_requests_userId_key"
  ON "account_deletion_requests"("userId");
CREATE INDEX "account_deletion_requests_status_requestedAt_idx"
  ON "account_deletion_requests"("status", "requestedAt");

ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
