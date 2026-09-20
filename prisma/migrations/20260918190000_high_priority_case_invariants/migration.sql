-- H1-H5 safety/case lifecycle hardening.
-- This migration preserves all historical rows. It aborts if active legacy
-- records violate an invariant instead of silently selecting or deleting one.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "cancellation_requests"
    WHERE "status" IN ('PENDING', 'DECLINED', 'ESCALATED', 'UNDER_REVIEW')
    GROUP BY "bookingId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one active cancellation request: conflicting active rows exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "completion_escalations"
    WHERE "status" IN ('PENDING', 'UNDER_REVIEW')
    GROUP BY "bookingId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one active completion escalation: conflicting active rows exist';
  END IF;
END $$;

ALTER TABLE "reports" ADD COLUMN "dedupeKey" TEXT;

ALTER TABLE "cancellation_requests"
  ADD COLUMN "reportId" TEXT,
  ADD COLUMN "resolutionOutcome" TEXT;

ALTER TABLE "completion_escalations"
  ADD CONSTRAINT "completion_escalations_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cancellation_requests"
  ADD CONSTRAINT "cancellation_requests_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "cancellation_requests_reportId_key"
  ON "cancellation_requests"("reportId");

CREATE UNIQUE INDEX "cancellation_requests_one_active_booking_key"
  ON "cancellation_requests"("bookingId")
  WHERE "status" IN ('PENDING', 'DECLINED', 'ESCALATED', 'UNDER_REVIEW');

CREATE UNIQUE INDEX "completion_escalations_one_active_booking_key"
  ON "completion_escalations"("bookingId")
  WHERE "status" IN ('PENDING', 'UNDER_REVIEW');

-- The former key rejected every second report by the same participant even
-- when it described a separate incident. Incident fingerprints replace it.
DROP INDEX IF EXISTS "reports_one_active_type_per_reporter_key";

-- Preserve duplicate prevention for active reports that predate this column.
-- This uses the same normalized incident identity as safety-report.service.ts.
UPDATE "reports"
SET "dedupeKey" = encode(
  digest(
    concat_ws(
      E'\x1f',
      "bookingId",
      "reporterId",
      'SAFETY',
      "reason"::text,
      lower(regexp_replace(btrim("description"), '\s+', ' ', 'g'))
    ),
    'sha256'
  ),
  'hex'
)
WHERE "reportType" = 'SAFETY'
  AND "status" IN ('PENDING', 'UNDER_REVIEW')
  AND "dedupeKey" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "reports"
    WHERE "dedupeKey" IS NOT NULL
      AND "status" IN ('PENDING', 'UNDER_REVIEW')
    GROUP BY "dedupeKey" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce active safety-report incident uniqueness: duplicate legacy incidents exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "reports_one_active_incident_key"
  ON "reports"("dedupeKey")
  WHERE "dedupeKey" IS NOT NULL AND "status" IN ('PENDING', 'UNDER_REVIEW');

CREATE TABLE "admin_resolution_operations" (
  "id" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "caseType" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "requestedByAdminId" TEXT NOT NULL,
  "requestedOutcome" TEXT NOT NULL,
  "requestedPenalty" TEXT,
  "notes" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "stage" TEXT NOT NULL DEFAULT 'CLAIMED',
  "lastError" TEXT,
  "result" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "admin_resolution_operations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_resolution_operations_operationKey_key"
  ON "admin_resolution_operations"("operationKey");
CREATE UNIQUE INDEX "admin_resolution_operations_caseType_caseId_key"
  ON "admin_resolution_operations"("caseType", "caseId");
CREATE INDEX "admin_resolution_operations_status_updatedAt_idx"
  ON "admin_resolution_operations"("status", "updatedAt");
CREATE INDEX "admin_resolution_operations_bookingId_status_idx"
  ON "admin_resolution_operations"("bookingId", "status");

-- Link only unambiguous legacy cancellation escalations. Ambiguous legacy
-- history remains untouched and is surfaced for operator review.
WITH unambiguous AS (
  SELECT cr."id" AS cancellation_id, MIN(r."id") AS report_id
  FROM "cancellation_requests" cr
  JOIN "reports" r
    ON r."bookingId" = cr."bookingId"
   AND r."reportType" = 'CANCELLATION_ESCALATION'
   AND r."status" IN ('PENDING', 'UNDER_REVIEW')
  WHERE cr."status" IN ('ESCALATED', 'UNDER_REVIEW')
  GROUP BY cr."id"
  HAVING COUNT(r."id") = 1
)
UPDATE "cancellation_requests" cr
SET "reportId" = unambiguous.report_id
FROM unambiguous
WHERE cr."id" = unambiguous.cancellation_id;
