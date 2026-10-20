-- Historical attempts and completions retain zero commission.
ALTER TABLE "payment_attempts"
  ADD COLUMN "commissionRateBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "platformFeeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "providerNetAmount" DECIMAL(10,2),
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "isTestMode" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "completed_services"
  ADD COLUMN "commissionRateBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "platformFeeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "providerNetAmount" DECIMAL(10,2);
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_commission_check"
  CHECK ("commissionRateBps" BETWEEN 0 AND 10000 AND "platformFeeAmount" >= 0
    AND ("providerNetAmount" IS NULL OR ("providerNetAmount" >= 0 AND "providerNetAmount" + "platformFeeAmount" = amount)));
ALTER TABLE "completed_services" ADD CONSTRAINT "completed_services_commission_check"
  CHECK ("commissionRateBps" BETWEEN 0 AND 10000 AND "platformFeeAmount" >= 0
    AND ("providerNetAmount" IS NULL OR ("providerNetAmount" >= 0 AND "providerNetAmount" + "platformFeeAmount" = "finalPrice")));
CREATE INDEX "payment_attempts_paidAt_idx" ON "payment_attempts"("paidAt");
