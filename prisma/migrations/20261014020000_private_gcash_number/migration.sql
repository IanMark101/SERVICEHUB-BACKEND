-- Do not copy contact phones into payment preferences.
ALTER TABLE "users" ADD COLUMN "gcashNumber" TEXT;
ALTER TABLE "users" ADD CONSTRAINT "users_gcash_number_format"
  CHECK ("gcashNumber" IS NULL OR "gcashNumber" ~ '^09[0-9]{9}$');
