-- Deploy with the backend stopped: this policy transition and its ledger entry
-- are atomic. Existing history is retained; new completion rewards are prospective.
BEGIN;
ALTER TABLE "reviews" ADD COLUMN "response" TEXT, ADD COLUMN "respondedAt" TIMESTAMP(3);
ALTER TABLE "trust_score_events" ADD COLUMN "bookingId" TEXT,
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'LEGACY', ADD COLUMN "penaltyKey" TEXT,
  ADD COLUMN "reversesEventId" TEXT;
ALTER TABLE "trust_score_events" ADD CONSTRAINT "trust_score_events_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trust_score_events" ADD CONSTRAINT "trust_score_events_reversesEventId_fkey"
  FOREIGN KEY ("reversesEventId") REFERENCES "trust_score_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "trust_score_events_reversesEventId_key" ON "trust_score_events"("reversesEventId");
CREATE INDEX "trust_score_events_bookingId_category_createdAt_idx" ON "trust_score_events"("bookingId", "category", "createdAt");
UPDATE "trust_score_events" e SET "bookingId" = b.id, category = 'COMPLETION'
  FROM bookings b WHERE e."eventKey" LIKE 'booking-completion:' || b.id || ':%';
UPDATE "trust_score_events" e SET "bookingId" = r."bookingId", category = 'REPORT_PENALTY'
  FROM reports r WHERE e."eventKey" LIKE 'report:' || r.id || ':%';
UPDATE "trust_score_events" e SET "bookingId" = c."bookingId", category = 'CANCELLATION_PENALTY'
  FROM cancellation_requests c WHERE e."eventKey" LIKE 'cancellation:' || c.id || ':%';
UPDATE trust_score_events SET category = 'REVIEW_LEGACY' WHERE "eventKey" LIKE 'review:%'
  OR reason ~ '^Received [1-5]-star( (provider|seeker))? review$'
  OR reason ~ '^Review rating updated from [1-5] to [1-5]$'
  OR reason IN ('Review hidden by administrator', 'Review restored by administrator');
-- Retain the earliest penalty for each booking/participant; never stack the same
-- incident's report and cancellation deductions.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY "bookingId", "userId" ORDER BY "createdAt", id) n
  FROM trust_score_events WHERE category IN ('REPORT_PENALTY', 'CANCELLATION_PENALTY')
) UPDATE trust_score_events e SET
  "penaltyKey" = CASE WHEN r.n = 1 THEN 'booking-penalty:' || e."bookingId" || ':' || e."userId" ELSE NULL END,
  category = CASE WHEN r.n = 1 THEN e.category ELSE 'LEGACY_DUPLICATE_PENALTY' END
  FROM ranked r WHERE e.id = r.id;
CREATE UNIQUE INDEX "trust_score_events_penaltyKey_key" ON "trust_score_events"("penaltyKey");

-- Replay events without review adjustments, rather than subtracting their net
-- sum. Replay handles interleaved awards/deductions at the 0/100 boundaries.
DO $$
DECLARE account RECORD; event RECORD; revised INTEGER; amount INTEGER;
BEGIN
  FOR account IN SELECT u.id, u."trustScore" FROM users u WHERE EXISTS (
    SELECT 1 FROM trust_score_events e WHERE e."userId" = u.id
      AND (e.category IN ('REVIEW_LEGACY', 'LEGACY_DUPLICATE_PENALTY') OR e."eventKey" LIKE 'review:%')
  ) LOOP
    SELECT "scoreBefore" INTO revised FROM trust_score_events WHERE "userId" = account.id ORDER BY "createdAt", id LIMIT 1;
    FOR event IN SELECT * FROM trust_score_events WHERE "userId" = account.id ORDER BY "createdAt", id LOOP
      IF event."eventKey" LIKE 'review:%' OR event.category IN ('REVIEW_LEGACY', 'LEGACY_DUPLICATE_PENALTY') THEN CONTINUE; END IF;
      amount := COALESCE(event."requestedDelta", CASE
        WHEN event.category = 'COMPLETION' THEN 3
        WHEN event.category = 'REPORT_PENALTY' OR event."eventKey" LIKE 'report:%' THEN -10
        WHEN event.category = 'CANCELLATION_PENALTY' OR event."eventKey" LIKE 'cancellation:%' THEN -5
        WHEN event."eventKey" LIKE 'verification-approval:%' THEN 5 ELSE event.delta END);
      revised := LEAST(100, GREATEST(0, revised + amount));
    END LOOP;
    INSERT INTO trust_score_events (id, "userId", delta, "requestedDelta", reason, "scoreBefore", "scoreAfter", "eventKey", category, "createdAt")
      VALUES ('trust-v2-' || account.id, account.id, revised - account."trustScore", revised - account."trustScore",
        'Trust policy updated: review points and duplicate booking penalties removed', account."trustScore", revised,
        'trust-policy:v2:' || account.id, 'POLICY_TRANSITION', CURRENT_TIMESTAMP);
    UPDATE users SET "trustScore" = revised WHERE id = account.id;
  END LOOP;
END $$;

CREATE TABLE "trust_cases" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "respondentId" TEXT,
  "reviewId" TEXT UNIQUE, "trustEventId" TEXT UNIQUE, "description" TEXT NOT NULL,
  "response" TEXT, "status" TEXT NOT NULL DEFAULT 'PENDING', "adminId" TEXT,
  "decisionReason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "decidedAt" TIMESTAMP(3),
  CONSTRAINT "trust_cases_one_source" CHECK (("reviewId" IS NULL) <> ("trustEventId" IS NULL)),
  CONSTRAINT "trust_cases_status" CHECK (status IN ('PENDING', 'UPHELD', 'REJECTED')),
  FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("respondentId") REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY ("adminId") REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY ("reviewId") REFERENCES reviews(id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("trustEventId") REFERENCES trust_score_events(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "trust_cases_status_createdAt_idx" ON "trust_cases"(status, "createdAt");
CREATE INDEX "trust_cases_userId_createdAt_idx" ON "trust_cases"("userId", "createdAt");
CREATE INDEX "trust_cases_respondentId_createdAt_idx" ON "trust_cases"("respondentId", "createdAt");
COMMIT;
