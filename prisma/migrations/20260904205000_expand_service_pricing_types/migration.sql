-- Migration-history repair for pricing/service-type fields that previously
-- reached the development database through schema synchronization.
ALTER TYPE "PriceType" ADD VALUE IF NOT EXISTS 'PER_SESSION';
ALTER TYPE "PriceType" ADD VALUE IF NOT EXISTS 'PER_DAY';
ALTER TYPE "PriceType" ADD VALUE IF NOT EXISTS 'PER_PROJECT';
ALTER TYPE "PriceType" ADD VALUE IF NOT EXISTS 'CUSTOM';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'ServiceType'
      AND typnamespace = current_schema()::regnamespace
  ) THEN
    CREATE TYPE "ServiceType" AS ENUM ('ONE_TIME', 'SESSION_BASED');
  END IF;
END
$$;

ALTER TABLE "services"
  ADD COLUMN IF NOT EXISTS "serviceType" "ServiceType" NOT NULL DEFAULT 'ONE_TIME';
