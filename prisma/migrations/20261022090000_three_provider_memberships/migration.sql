ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'BASIC' BEFORE 'PRO';

ALTER TABLE "users"
  ADD COLUMN "freePlanStartedAt" TIMESTAMP(3),
  ADD COLUMN "freePlanExpiresAt" TIMESTAMP(3);

-- Existing providers receive a new, complete trial at rollout. Customer-only
-- accounts start their one trial when they first enter the Provider workspace.
UPDATE "users" u SET "freePlanStartedAt" = CURRENT_TIMESTAMP,
  "freePlanExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 days'
WHERE u.role = 'user' AND (
  EXISTS (SELECT 1 FROM services s WHERE s."providerId" = u.id)
  OR EXISTS (SELECT 1 FROM offers o WHERE o."providerId" = u.id)
  OR EXISTS (SELECT 1 FROM bookings b WHERE b."providerId" = u.id)
  OR u."subscriptionPlan"::text = 'PRO'
);

ALTER TABLE "subscription_payments"
  ADD COLUMN "billingAction" TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN "quotedMembershipUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "quotedPeriodExpiresAt" TIMESTAMP(3);

-- Preserve already-paid Pro periods. Expired legacy providers get the rollout
-- trial; their historical paid records and period dates remain intact.
UPDATE "users" SET "subscriptionPlan" = 'FREE', "subscriptionStatus" = 'ACTIVE'
WHERE role = 'user' AND "subscriptionPlan"::text = 'PRO'
  AND ("subscriptionStatus"::text = 'EXPIRED' OR "subscriptionExpiresAt" <= CURRENT_TIMESTAMP);

WITH ranked AS (
  SELECT s.id, row_number() OVER (PARTITION BY s."providerId" ORDER BY s."publishedAt" ASC, s.id ASC) AS position
  FROM services s JOIN users u ON u.id = s."providerId"
  WHERE s.status = 'ACTIVE' AND u."subscriptionPlan"::text = 'FREE'
)
UPDATE services SET status = 'INACTIVE', "isAvailable" = false
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

ALTER TABLE "users" ADD CONSTRAINT "users_free_period_check" CHECK (
  ("freePlanStartedAt" IS NULL AND "freePlanExpiresAt" IS NULL)
  OR ("freePlanStartedAt" IS NOT NULL AND "freePlanExpiresAt" > "freePlanStartedAt")
);
CREATE INDEX "users_free_membership_expiry_idx" ON "users" ("freePlanExpiresAt");
