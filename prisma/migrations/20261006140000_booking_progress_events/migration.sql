-- Additive history only: no existing booking state or business rules change.
CREATE TABLE "booking_progress_events" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "booking_progress_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "booking_progress_events_bookingId_eventKey_key" ON "booking_progress_events"("bookingId", "eventKey");
CREATE INDEX "booking_progress_events_bookingId_occurredAt_idx" ON "booking_progress_events"("bookingId", "occurredAt");
ALTER TABLE "booking_progress_events" ADD CONSTRAINT "booking_progress_events_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Earlier action times cannot be recovered from a booking's updatedAt.
-- Do not backfill estimated or invented acceptance/start/completion times.
