-- Normalize active queue positions before installing integrity constraints.
-- SERVING entries remain first, followed by WAITING entries in stable FCFS order.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "serviceId"
      ORDER BY CASE WHEN "status" = 'SERVING' THEN 0 ELSE 1 END,
               "position", "joinedAt", "id"
    )::integer AS next_position
  FROM "queue"
  WHERE "status" IN ('WAITING', 'SERVING')
)
UPDATE "queue" AS queue
SET "position" = ranked.next_position
FROM ranked
WHERE queue."id" = ranked."id";

UPDATE "bookings" AS booking
SET "queuePosition" = queue."position"
FROM "queue" AS queue
WHERE queue."bookingId" = booking."id"
  AND queue."status" IN ('WAITING', 'SERVING');

ALTER TABLE "queue"
  ADD CONSTRAINT "queues_position_positive"
  CHECK ("position" > 0);

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_queue_position_positive"
  CHECK ("queuePosition" IS NULL OR "queuePosition" > 0);

CREATE UNIQUE INDEX "queues_service_active_position_key"
  ON "queue" ("serviceId", "position")
  WHERE "status" IN ('WAITING', 'SERVING');

CREATE UNIQUE INDEX "queues_one_serving_per_service_key"
  ON "queue" ("serviceId")
  WHERE "status" = 'SERVING';

CREATE UNIQUE INDEX "bookings_one_ongoing_per_provider_key"
  ON "bookings" ("providerId")
  WHERE "status" = 'ONGOING';

CREATE UNIQUE INDEX "completion_escalations_one_active_per_booking_key"
  ON "completion_escalations" ("bookingId")
  WHERE "status" IN ('PENDING', 'UNDER_REVIEW');
