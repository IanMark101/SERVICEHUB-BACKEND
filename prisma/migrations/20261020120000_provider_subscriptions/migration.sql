CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'PRO');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUND_REQUIRED', 'REFUNDED');
ALTER TABLE "users"
  ADD COLUMN "subscriptionPlan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
  ADD COLUMN "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "subscriptionStartedAt" TIMESTAMP(3),
  ADD COLUMN "subscriptionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "subscriptionUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE "subscription_payments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "plan" "SubscriptionPlan" NOT NULL DEFAULT 'PRO',
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PHP',
  "paymentMethod" TEXT NOT NULL DEFAULT 'gcash',
  "paymentReference" TEXT,
  "providerIntentId" TEXT,
  "providerClientKey" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "redirectUrl" TEXT,
  "paymentStatus" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "isTestMode" BOOLEAN NOT NULL DEFAULT true,
  "checkoutExpiresAt" TIMESTAMP(3) NOT NULL,
  "checkoutClaimedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "subscriptionStartedAt" TIMESTAMP(3),
  "subscriptionExpiresAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscription_payments_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_amount_positive" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "subscription_payments_paymentReference_key" ON "subscription_payments"("paymentReference");
CREATE UNIQUE INDEX "subscription_payments_providerIntentId_key" ON "subscription_payments"("providerIntentId");
CREATE UNIQUE INDEX "subscription_payments_idempotencyKey_key" ON "subscription_payments"("idempotencyKey");
CREATE INDEX "subscription_payments_providerId_createdAt_idx" ON "subscription_payments"("providerId", "createdAt");
CREATE INDEX "subscription_payments_paymentStatus_createdAt_idx" ON "subscription_payments"("paymentStatus", "createdAt");
CREATE INDEX "users_subscription_expiry_idx" ON "users"("subscriptionPlan", "subscriptionExpiresAt");
