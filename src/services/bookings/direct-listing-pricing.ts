import { Prisma, type PriceType } from "@prisma/client";

/** Calculate exact direct-listing terms without trusting a client-supplied total. */
export function calculateDirectListingTerms(
  priceType: PriceType,
  listedPrice: Prisma.Decimal | null,
  quantity: number,
  listedDurationMins: number,
) {
  if (!["FIXED", "PER_HOUR", "PER_DAY", "PER_PROJECT"].includes(priceType)) {
    throw Object.assign(new Error("This listing needs a provider price confirmation before booking"), { status: 400 });
  }
  const maxQuantity = priceType === "PER_DAY" ? 7 : priceType === "PER_HOUR" ? 40 : 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
    throw Object.assign(new Error("Choose a valid number of hours or days for this listing"), { status: 400 });
  }
  if (!listedPrice) throw Object.assign(new Error("This listing is missing a valid price"), { status: 409 });
  const amount = listedPrice.mul(quantity);
  if (amount.lessThan(50) || amount.greaterThan(50_000)) {
    throw Object.assign(new Error("The booking total must be between ₱50 and ₱50,000"), { status: 400 });
  }
  return {
    amount,
    estimatedDurationMins: priceType === "PER_HOUR" ? 60 * quantity : priceType === "PER_DAY" ? 480 * quantity : listedDurationMins,
  };
}
