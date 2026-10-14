import type { PriceType } from '@prisma/client';

export const RATE_PRICE_TYPES: PriceType[] = ['FIXED', 'PER_HOUR', 'PER_DAY', 'PER_PROJECT'];
export function validListingPrice(type: PriceType, price: unknown) {
  if (type === 'BY_AGREEMENT') return price === null;
  return RATE_PRICE_TYPES.includes(type) && price !== null && Number.isFinite(Number(price)) && Number(price) >= 50 && Number(price) <= 50_000;
}
