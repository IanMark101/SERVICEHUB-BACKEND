-- Additive migration. Historical locations remain unknown; never invent pins.
ALTER TABLE "services"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "locationLabel" TEXT,
  ADD COLUMN "coverageRadiusKm" DOUBLE PRECISION,
  ADD COLUMN "transportationFee" DECIMAL(10,2);
ALTER TABLE "service_requests"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "locationLabel" TEXT,
  ADD COLUMN "privateAddress" TEXT,
  ADD COLUMN "transportationFee" DECIMAL(10,2);
ALTER TABLE "bookings" ADD COLUMN "jobLocation" JSONB, ADD COLUMN "transportationFee" DECIMAL(10,2);
ALTER TABLE "payment_attempts"
  ADD COLUMN "jobLocation" JSONB,
  ADD COLUMN "transportationFee" DECIMAL(10,2),
  ADD COLUMN "estimatedDurationMins" INTEGER;
CREATE INDEX "services_latitude_longitude_idx" ON "services"("latitude", "longitude");
CREATE INDEX "service_requests_latitude_longitude_idx" ON "service_requests"("latitude", "longitude");
ALTER TABLE "services" ADD CONSTRAINT "services_location_valid" CHECK (
  ("latitude" IS NULL AND "longitude" IS NULL AND "locationLabel" IS NULL)
  OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "locationLabel" IS NOT NULL
      AND "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)
);
ALTER TABLE "service_requests" ADD CONSTRAINT "requests_location_valid" CHECK (
  ("latitude" IS NULL AND "longitude" IS NULL AND "locationLabel" IS NULL)
  OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "locationLabel" IS NOT NULL
      AND "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)
);
ALTER TABLE "services" ADD CONSTRAINT "services_coverage_valid" CHECK ("coverageRadiusKm" IS NULL OR ("coverageRadiusKm" BETWEEN 1 AND 30 AND "latitude" IS NOT NULL));
ALTER TABLE "services" ADD CONSTRAINT "services_transportation_fee_valid" CHECK ("transportationFee" IS NULL OR "transportationFee" BETWEEN 0 AND 5000);
ALTER TABLE "service_requests" ADD CONSTRAINT "requests_transportation_fee_valid" CHECK ("transportationFee" IS NULL OR "transportationFee" BETWEEN 0 AND 5000);
