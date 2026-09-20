-- Abort instead of choosing a winner or deleting history when legacy data
-- violates the new invariants. Operators must investigate those rows first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "offers"
    WHERE "status" IN ('PENDING_PAYMENT', 'ACCEPTED')
    GROUP BY "requestId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one selected offer per request: conflicting offer rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "bookings"
    WHERE "serviceId" IS NOT NULL
      AND "status" IN ('PENDING_APPROVAL', 'WAITING', 'ACCEPTED', 'ONGOING', 'AWAITING_CONFIRMATION', 'UNDER_REVIEW', 'DISPUTED')
    GROUP BY "seekerId", "serviceId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one active seeker/service booking: conflicting booking rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "offers_one_selected_per_request_key"
  ON "offers" ("requestId")
  WHERE "status" IN ('PENDING_PAYMENT', 'ACCEPTED');

CREATE UNIQUE INDEX "bookings_one_active_seeker_service_key"
  ON "bookings" ("seekerId", "serviceId")
  WHERE "serviceId" IS NOT NULL
    AND "status" IN ('PENDING_APPROVAL', 'WAITING', 'ACCEPTED', 'ONGOING', 'AWAITING_CONFIRMATION', 'UNDER_REVIEW', 'DISPUTED');
