-- Post Request broadcasts a public job. A provider ID without a selected
-- service is obsolete metadata, not an intentional private listing inquiry.
-- Repair every affected request without changing offers, bookings or payments.
UPDATE "service_requests"
SET "targetProviderId" = NULL
WHERE "targetServiceId" IS NULL AND "targetProviderId" IS NOT NULL;

ALTER TABLE "service_requests"
ADD CONSTRAINT "service_requests_target_provider_requires_listing_check"
CHECK ("targetProviderId" IS NULL OR "targetServiceId" IS NOT NULL);
