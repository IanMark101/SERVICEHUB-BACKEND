-- Preserve historical records. Operators must reconcile active duplicates
-- explicitly before these invariants can be installed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "service_verifications"
    WHERE "status" = 'PENDING_REVIEW'
    GROUP BY "userId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one pending verification per user: conflicting rows exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "offers"
    WHERE "status" IN ('PENDING', 'PENDING_PAYMENT', 'ACCEPTED')
    GROUP BY "requestId", "providerId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one active offer per provider and request: conflicting rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "service_verifications_one_pending_user_key"
  ON "service_verifications"("userId") WHERE "status" = 'PENDING_REVIEW';

CREATE UNIQUE INDEX "offers_one_active_provider_request_key"
  ON "offers"("requestId", "providerId")
  WHERE "status" IN ('PENDING', 'PENDING_PAYMENT', 'ACCEPTED');
