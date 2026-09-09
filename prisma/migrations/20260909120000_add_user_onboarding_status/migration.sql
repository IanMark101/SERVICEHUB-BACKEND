-- Do not interrupt existing ServiceHub users with an automatic first-time
-- tour. New accounts use the PENDING default set after this backfill.
CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING', 'COMPLETED', 'SKIPPED');

ALTER TABLE "users"
ADD COLUMN "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'COMPLETED';

ALTER TABLE "users"
ALTER COLUMN "onboardingStatus" SET DEFAULT 'PENDING';
