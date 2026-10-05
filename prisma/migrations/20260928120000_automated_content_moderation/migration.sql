ALTER TABLE "services"
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "moderationPolicyVersion" TEXT,
  ADD COLUMN "moderationReasonCode" TEXT;

-- Existing ACTIVE listings were published under the earlier Admin-only policy.
UPDATE "services"
SET "publishedAt" = COALESCE("reviewedAt", "createdAt")
WHERE "status" IN ('ACTIVE', 'INACTIVE', 'SUSPENDED');

ALTER TABLE "service_requests" ADD COLUMN "moderationPolicyVersion" TEXT;

CREATE TABLE "content_moderation_events" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "resourceId" TEXT,
  "outcome" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_moderation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "services_status_publishedAt_idx" ON "services"("status", "publishedAt");
CREATE INDEX "content_moderation_events_actorId_createdAt_idx" ON "content_moderation_events"("actorId", "createdAt");
CREATE INDEX "content_moderation_events_contentType_resourceId_idx" ON "content_moderation_events"("contentType", "resourceId");

CREATE TABLE "content_moderation_cases" (
  "id" TEXT NOT NULL,
  "submitterId" TEXT NOT NULL,
  "caseType" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "resourceId" TEXT,
  "reason" VARCHAR(1000) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "adminId" TEXT,
  "resolution" VARCHAR(1000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "content_moderation_cases_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "content_moderation_cases" ADD CONSTRAINT "content_moderation_cases_submitterId_fkey"
  FOREIGN KEY ("submitterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "content_moderation_cases_status_createdAt_idx" ON "content_moderation_cases"("status", "createdAt");
CREATE INDEX "content_moderation_cases_submitterId_createdAt_idx" ON "content_moderation_cases"("submitterId", "createdAt");
