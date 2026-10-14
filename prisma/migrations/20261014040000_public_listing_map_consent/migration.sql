-- Existing coordinates remain private unless their owner explicitly opts in.
ALTER TABLE "services" ADD COLUMN "publicMapPin" BOOLEAN NOT NULL DEFAULT false;
