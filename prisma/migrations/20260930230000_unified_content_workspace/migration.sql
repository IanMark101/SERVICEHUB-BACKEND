ALTER TABLE "service_requests"
  ADD COLUMN "moderationReasonCode" TEXT,
  ADD COLUMN "adminNotes" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT;

ALTER TABLE "content_moderation_cases"
  ADD COLUMN "contentOwnerId" TEXT,
  ADD COLUMN "contentSnapshot" JSONB,
  ADD COLUMN "decision" TEXT,
  ADD COLUMN "penalty" TEXT,
  ADD COLUMN "decisionResult" JSONB,
  ADD COLUMN "decidedAt" TIMESTAMP(3);
CREATE INDEX "content_moderation_cases_contentOwnerId_createdAt_idx" ON "content_moderation_cases"("contentOwnerId", "createdAt");

UPDATE "content_moderation_cases" c SET "contentOwnerId" = s."providerId"
FROM "services" s WHERE c."contentType"='SERVICE_LISTING' AND c."resourceId"=s.id;
UPDATE "content_moderation_cases" c SET "contentOwnerId" = r."seekerId"
FROM "service_requests" r WHERE c."contentType"='SERVICE_REQUEST' AND c."resourceId"=r.id;

-- Identify historical admin removals from actual audit evidence. User-canceled
-- requests are never made restorable by guessing from CANCELED alone.
UPDATE "service_requests" r SET "moderationReasonCode"='ADMIN_REMOVED',
  "adminNotes"=a.reason, "reviewedById"=a."actorId", "reviewedAt"=a."createdAt"
FROM (SELECT DISTINCT ON ("resourceId") "resourceId", reason, "actorId", "createdAt"
  FROM "admin_audit_logs" WHERE action='REQUEST_CONTENT_REMOVED' ORDER BY "resourceId", "createdAt" DESC) a
WHERE r.id=a."resourceId" AND r.status='CANCELED';
