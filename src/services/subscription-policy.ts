/** One policy for fees, listing capacity and featured eligibility. */
export interface SubscriptionState {
  subscriptionPlan: string;
  subscriptionStatus: string;
  subscriptionStartedAt: Date | null;
  subscriptionExpiresAt: Date | null;
}

export const PRO_MONTHLY_PRICE = 199;
export const FREE_LISTING_LIMIT = 3;
export const subscriptionSelect = {
  subscriptionPlan: true, subscriptionStatus: true,
  subscriptionStartedAt: true, subscriptionExpiresAt: true,
} as const;

export function subscriptionBenefits(state: SubscriptionState, now = new Date()) {
  const pro = state.subscriptionPlan === 'PRO'
    && ['ACTIVE', 'CANCELLED'].includes(state.subscriptionStatus)
    && state.subscriptionStartedAt !== null && state.subscriptionStartedAt <= now
    && state.subscriptionExpiresAt !== null && state.subscriptionExpiresAt > now;
  return { plan: pro ? 'PRO' as const : 'FREE' as const,
    commissionRateBps: pro ? 500 : 1000,
    activeListingLimit: pro ? null : FREE_LISTING_LIMIT,
    featuredPriority: pro };
}

/** A Philippine calendar month, clamping month-end without changing local time. */
export function oneCalendarMonthFrom(start: Date) {
  const philippineOffset = 8 * 60 * 60 * 1000;
  const end = new Date(start.getTime() + philippineOffset);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, last));
  return new Date(end.getTime() - philippineOffset);
}

export function assertListingCapacity(state: SubscriptionState, activeCount: number, now = new Date()) {
  const { activeListingLimit } = subscriptionBenefits(state, now);
  if (activeListingLimit !== null && activeCount >= activeListingLimit) {
    throw Object.assign(new Error("You've reached the 3-service listing limit on the Free plan. Upgrade to Pro to create unlimited service listings."),
      { status: 422, code: 'FREE_LISTING_LIMIT' });
  }
}
