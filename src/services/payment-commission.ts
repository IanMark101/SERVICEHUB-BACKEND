import { Prisma } from '@prisma/client';

export const GCASH_COMMISSION_BPS = 1_000;

/** Snapshot the agreed total, including travel. Round the fee once to centavos. */
export function paymentCommission(amount: Prisma.Decimal | number | string, rateBps = GCASH_COMMISSION_BPS) {
  const gross = new Prisma.Decimal(amount);
  if (!gross.isFinite() || gross.lte(0) || !gross.equals(gross.toDecimalPlaces(2)) || !Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error('Invalid commission terms');
  }
  const platformFeeAmount = gross.mul(rateBps).div(10_000).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { commissionRateBps: rateBps, platformFeeAmount, providerNetAmount: gross.minus(platformFeeAmount) };
}

export function commissionResponse(attempt: { commissionRateBps?: number; platformFeeAmount?: Prisma.Decimal | number; providerNetAmount?: Prisma.Decimal | number | null; amount: Prisma.Decimal | number }) {
  return {
    ratePercent: (attempt.commissionRateBps ?? 0) / 100,
    platformFeeAmount: Number(attempt.platformFeeAmount ?? 0),
    providerNetAmount: Number(attempt.providerNetAmount ?? attempt.amount),
  };
}
