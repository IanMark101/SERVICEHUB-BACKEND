ALTER TABLE "email_verification_tokens"
ADD COLUMN "used" BOOLEAN NOT NULL DEFAULT false;
