CREATE TYPE "ServiceLocationMode" AS ENUM ('PROVIDER_VISITS', 'SEEKER_VISITS', 'BOTH');

ALTER TABLE "services"
  ADD COLUMN "serviceLocationMode" "ServiceLocationMode" NOT NULL DEFAULT 'PROVIDER_VISITS',
  ADD COLUMN "venueAddress" TEXT;
ALTER TABLE "service_requests"
  ADD COLUMN "serviceLocationMode" "ServiceLocationMode" NOT NULL DEFAULT 'PROVIDER_VISITS';
ALTER TABLE "offers"
  ADD COLUMN "serviceLocationMode" "ServiceLocationMode",
  ADD COLUMN "providerVenue" JSONB;
ALTER TABLE "bookings" ADD COLUMN "serviceLocationMode" "ServiceLocationMode";
ALTER TABLE "payment_attempts" ADD COLUMN "serviceLocationMode" "ServiceLocationMode";
