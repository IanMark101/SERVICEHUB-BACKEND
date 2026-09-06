-- Migration-history repair: this model existed in the development database
-- before it was referenced by later recorded migrations. Keep this bridge
-- idempotent so databases that already contain the table remain safe.
CREATE TABLE IF NOT EXISTS "trust_score_events" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "scoreBefore" INTEGER NOT NULL,
  "scoreAfter" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trust_score_events_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'trust_score_events_userId_fkey'
      AND conrelid = 'trust_score_events'::regclass
  ) THEN
    ALTER TABLE "trust_score_events"
      ADD CONSTRAINT "trust_score_events_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
