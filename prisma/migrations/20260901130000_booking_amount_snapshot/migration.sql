ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "agreedAmount" DECIMAL(10,2);

UPDATE "bookings" AS b
SET "agreedAmount" = COALESCE(
  dr."agreedPrice",
  o."offeredPrice",
  s."price"
)
FROM "bookings" AS source
LEFT JOIN "direct_requests" AS dr ON dr."id" = source."directRequestId"
LEFT JOIN "offers" AS o ON o."id" = source."offerId"
LEFT JOIN "services" AS s ON s."id" = source."serviceId"
WHERE b."id" = source."id"
  AND b."agreedAmount" IS NULL;
