-- Each listing remains reusable, while every booking is an independent
-- ONE_TIME engagement. Enum members remain for backward compatibility.
UPDATE "services"
SET "serviceType" = 'ONE_TIME'::"ServiceType"
WHERE "serviceType" = 'SESSION_BASED'::"ServiceType";

UPDATE "services"
SET "priceType" = 'FIXED'::"PriceType"
WHERE "priceType" = 'PER_SESSION'::"PriceType";
