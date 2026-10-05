-- Provider-wide paid queue. Existing paid jobs keep their admission time and
-- are assigned one deterministic order before the provider-scoped indexes land.
ALTER TABLE "users" ADD COLUMN "onlineQueueLimit" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "bookings" ADD COLUMN "estimatedDurationMins" INTEGER;

UPDATE "bookings" AS b
SET "estimatedDurationMins" = COALESCE(o."estimatedDuration", s."estimatedDurationMins", 60)
FROM "bookings" AS source
LEFT JOIN "offers" AS o ON o."id" = source."offerId"
LEFT JOIN "services" AS s ON s."id" = source."serviceId"
WHERE b."id" = source."id";

ALTER TABLE "queue" ADD COLUMN "providerId" TEXT;
UPDATE "queue" AS q
SET "providerId" = b."providerId"
FROM "bookings" AS b
WHERE q."bookingId" = b."id";
UPDATE "queue" AS q
SET "providerId" = s."providerId"
FROM "services" AS s
WHERE q."providerId" IS NULL AND q."serviceId" = s."id";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "queue" WHERE "providerId" IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate queue rows without a provider; repair data before applying provider-wide workload migration';
  END IF;
  IF EXISTS (
    SELECT "providerId" FROM "queue" WHERE "status" = 'SERVING'
    GROUP BY "providerId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Provider has multiple SERVING jobs; reconcile before applying provider-wide workload migration';
  END IF;
END $$;

ALTER TABLE "queue" ALTER COLUMN "providerId" SET NOT NULL;
ALTER TABLE "queue" ADD CONSTRAINT "queue_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "queue" DROP CONSTRAINT IF EXISTS "queue_serviceId_fkey";
ALTER TABLE "queue" ALTER COLUMN "serviceId" DROP NOT NULL;
ALTER TABLE "queue" ADD CONSTRAINT "queue_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_attempts" ALTER COLUMN "serviceId" DROP NOT NULL;
DROP INDEX IF EXISTS "payment_attempts_seekerId_serviceId_status_idx";
CREATE INDEX "payment_attempts_seekerId_providerId_status_idx"
  ON "payment_attempts"("seekerId", "providerId", "status");

DROP INDEX IF EXISTS "queues_service_active_position_key";
DROP INDEX IF EXISTS "queues_one_serving_per_service_key";
DROP INDEX IF EXISTS "queue_serviceId_status_position_idx";

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "providerId"
    ORDER BY CASE WHEN "status" = 'SERVING' THEN 0 ELSE 1 END,
             "joinedAt", "id"
  )::integer AS next_position
  FROM "queue" WHERE "status" IN ('WAITING', 'SERVING')
)
UPDATE "queue" AS q SET "position" = ranked.next_position
FROM ranked WHERE q."id" = ranked."id";

UPDATE "bookings" AS b SET "queuePosition" = q."position"
FROM "queue" AS q WHERE q."bookingId" = b."id"
  AND q."status" IN ('WAITING', 'SERVING');

WITH ranked AS (
  SELECT q."id", COALESCE(SUM(COALESCE(b."estimatedDurationMins", 60)) OVER (
    PARTITION BY q."providerId" ORDER BY q."position"
    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ), 0)::integer AS wait_minutes
  FROM "queue" AS q LEFT JOIN "bookings" AS b ON b."id" = q."bookingId"
  WHERE q."status" IN ('WAITING', 'SERVING')
)
UPDATE "queue" AS q SET "estimatedWait" = ranked.wait_minutes
FROM ranked WHERE q."id" = ranked."id";

CREATE INDEX "queue_providerId_status_position_idx"
  ON "queue"("providerId", "status", "position");
CREATE UNIQUE INDEX "queues_provider_active_position_key"
  ON "queue"("providerId", "position")
  WHERE "status" IN ('WAITING', 'SERVING');
CREATE UNIQUE INDEX "queues_one_serving_per_provider_key"
  ON "queue"("providerId") WHERE "status" = 'SERVING';
ALTER TABLE "users" ADD CONSTRAINT "users_online_queue_limit_range"
  CHECK ("onlineQueueLimit" BETWEEN 1 AND 10);
