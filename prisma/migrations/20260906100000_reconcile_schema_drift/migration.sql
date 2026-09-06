-- Bring databases created through earlier schema synchronization into exact
-- agreement with the checked-in Prisma schema and fresh migration history.
ALTER TABLE "ai_review_summaries"
  ALTER COLUMN "contentVersion" DROP DEFAULT;

CREATE INDEX IF NOT EXISTS "bookings_providerId_status_idx"
  ON "bookings"("providerId", "status");

CREATE INDEX IF NOT EXISTS "bookings_serviceId_status_idx"
  ON "bookings"("serviceId", "status");

CREATE INDEX IF NOT EXISTS "queue_serviceId_status_position_idx"
  ON "queue"("serviceId", "status", "position");
