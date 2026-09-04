-- Preserve the actual counterparty and neutral response wording for the
-- bidirectional cancellation policy. The legacy providerNote remains readable
-- for historical clients while responderNote becomes canonical.
ALTER TABLE "cancellation_requests"
  ADD COLUMN "responderId" TEXT,
  ADD COLUMN "responderNote" TEXT;

UPDATE "cancellation_requests" AS cancellation
SET
  "responderId" = CASE
    WHEN cancellation."requestedBy" = booking."seekerId" THEN booking."providerId"
    ELSE booking."seekerId"
  END,
  "responderNote" = cancellation."providerNote"
FROM "bookings" AS booking
WHERE booking."id" = cancellation."bookingId";

ALTER TABLE "cancellation_requests"
  ADD CONSTRAINT "cancellation_requests_responderId_fkey"
  FOREIGN KEY ("responderId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "cancellation_requests_responderId_status_idx"
  ON "cancellation_requests"("responderId", "status");
