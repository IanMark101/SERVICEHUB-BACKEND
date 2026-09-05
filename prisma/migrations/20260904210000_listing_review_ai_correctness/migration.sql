ALTER TABLE "services" ADD COLUMN "titleNormalized" TEXT;

UPDATE "services"
SET "titleNormalized" = LOWER(REGEXP_REPLACE(TRIM("title"), '\s+', ' ', 'g'));

ALTER TABLE "services" ALTER COLUMN "titleNormalized" SET NOT NULL;
ALTER TABLE "services" ALTER COLUMN "price" DROP NOT NULL;

UPDATE "services" SET "price" = NULL WHERE "priceType" = 'CUSTOM';

DROP INDEX IF EXISTS "services_providerId_title_key";

CREATE UNIQUE INDEX "services_provider_active_title_key"
  ON "services" ("providerId", "titleNormalized")
  WHERE "status" IN ('PENDING_REVIEW', 'ACTIVE');

CREATE INDEX "services_providerId_status_idx" ON "services"("providerId", "status");

ALTER TABLE "reviews" ADD COLUMN "contentVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ai_review_summaries"
  ADD COLUMN "contentVersion" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'computed';
