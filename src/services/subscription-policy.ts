import { Prisma } from '@prisma/client';

export type ProviderPlan = 'FREE' | 'BASIC' | 'PRO';
export type PaidProviderPlan = Exclude<ProviderPlan, 'FREE'>;
export interface SubscriptionState {
  subscriptionPlan: string;
  subscriptionStatus: string;
  subscriptionStartedAt: Date | null;
  subscriptionExpiresAt: Date | null;
  freePlanStartedAt?: Date | null;
  freePlanExpiresAt?: Date | null;
}
export const PROVIDER_PLANS = {
  FREE: { monthlyPrice: 0, activeListingLimit: 1, commissionRateBps: 1000 },
  BASIC: { monthlyPrice: 99, activeListingLimit: 3, commissionRateBps: 800 },
  PRO: { monthlyPrice: 199, activeListingLimit: null, commissionRateBps: 500 },
} as const;
export const PRO_MONTHLY_PRICE = PROVIDER_PLANS.PRO.monthlyPrice;
export const FREE_LISTING_LIMIT = PROVIDER_PLANS.FREE.activeListingLimit;
export const FREE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const subscriptionSelect = {
  subscriptionPlan: true, subscriptionStatus: true,
  subscriptionStartedAt: true, subscriptionExpiresAt: true,
  freePlanStartedAt: true, freePlanExpiresAt: true,
} as const;

export function subscriptionBenefits(state: SubscriptionState, now = new Date()) {
  const plan: ProviderPlan = state.subscriptionPlan === 'PRO' ? 'PRO' : state.subscriptionPlan === 'BASIC' ? 'BASIC' : 'FREE';
  const startsAt = plan === 'FREE' ? state.freePlanStartedAt : state.subscriptionStartedAt;
  const expiresAt = plan === 'FREE' ? state.freePlanExpiresAt : state.subscriptionExpiresAt;
  const marketplaceAccess = (plan === 'FREE' || ['ACTIVE', 'CANCELLED'].includes(state.subscriptionStatus))
    && !!startsAt && startsAt <= now && !!expiresAt && expiresAt > now;
  return { plan, ...PROVIDER_PLANS[plan], marketplaceAccess,
    status: marketplaceAccess ? (state.subscriptionStatus === 'CANCELLED' && plan !== 'FREE' ? 'CANCELLED' as const : 'ACTIVE' as const) : 'EXPIRED' as const,
    startsAt: startsAt ?? null, expiresAt: expiresAt ?? null,
    trialStarted: !!state.freePlanStartedAt,
    daysRemaining: marketplaceAccess && expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000) : 0,
    fullAnalytics: marketplaceAccess && plan !== 'FREE',
    featuredPriority: marketplaceAccess && plan === 'PRO' };
}

/** Evaluate expiry at query time, never once at process startup. */
export function providerMembershipWhere(now = new Date()): Prisma.UserWhereInput {
  return { OR: [
    { subscriptionPlan: 'FREE', freePlanStartedAt: { lte: now }, freePlanExpiresAt: { gt: now } },
    { subscriptionPlan: { in: ['BASIC', 'PRO'] }, subscriptionStatus: { in: ['ACTIVE', 'CANCELLED'] },
      subscriptionStartedAt: { lte: now }, subscriptionExpiresAt: { gt: now } },
  ] };
}
export function assertMembershipAccess(state: SubscriptionState, now = new Date()) {
  if (!subscriptionBenefits(state, now).marketplaceAccess) throw Object.assign(
    new Error('Your provider membership has ended. Choose Basic or Pro to accept new customers. Existing bookings remain available.'),
    { status: 403, code: 'PROVIDER_MEMBERSHIP_EXPIRED' });
}
export function assertListingCapacity(state: SubscriptionState, activeCount: number, now = new Date()) {
  assertMembershipAccess(state, now);
  const { activeListingLimit, plan } = subscriptionBenefits(state, now);
  if (activeListingLimit !== null && activeCount >= activeListingLimit) throw Object.assign(
    new Error(`Your ${plan === 'FREE' ? 'Free' : 'Basic'} plan allows ${activeListingLimit} active ${activeListingLimit === 1 ? 'listing' : 'listings'}. Choose a higher plan to publish more.`),
    { status: 422, code: 'PROVIDER_LISTING_LIMIT' });
}
/** A Philippine calendar month, clamping month-end without changing local time. */
export function oneCalendarMonthFrom(start: Date) {
  const offset = 8 * 60 * 60 * 1000;
  const end = new Date(start.getTime() + offset); const day = end.getUTCDate();
  end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + 1);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, last));
  return new Date(end.getTime() - offset);
}
/** Exact centavo rounding; upgrade keeps the already-paid calendar-month end. */
export function membershipQuote(state: SubscriptionState & { subscriptionUpdatedAt: Date }, target: PaidProviderPlan, now = new Date()) {
  const benefits = subscriptionBenefits(state, now);
  if (benefits.marketplaceAccess && benefits.plan === target) throw Object.assign(new Error('This plan is already active. Renew after it expires.'), { status: 409 });
  if (benefits.marketplaceAccess && benefits.plan === 'PRO' && target === 'BASIC') throw Object.assign(new Error('Your Pro benefits stay active until expiry. Choose Basic after that date.'), { status: 409 });
  if (benefits.marketplaceAccess && benefits.plan === 'BASIC' && target === 'PRO') {
    const duration = state.subscriptionExpiresAt!.getTime() - state.subscriptionStartedAt!.getTime();
    const remaining = state.subscriptionExpiresAt!.getTime() - now.getTime();
    const amount = new Prisma.Decimal(PROVIDER_PLANS.PRO.monthlyPrice - PROVIDER_PLANS.BASIC.monthlyPrice)
      .mul(remaining).div(duration).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    // PayMongo GCash minimum is PHP 1. A sub-peso upgrade is available once the
    // current period ends, without rounding up the provider's quoted charge.
    if (amount.lt(1)) throw Object.assign(new Error('Your Basic month is nearly over. Choose Pro after it expires to start a new month.'), { status: 409 });
    return { plan: target, amount, billingAction: 'UPGRADE', quotedPeriodExpiresAt: state.subscriptionExpiresAt!,
      quotedMembershipUpdatedAt: state.subscriptionUpdatedAt };
  }
  return { plan: target, amount: new Prisma.Decimal(PROVIDER_PLANS[target].monthlyPrice),
    billingAction: state.subscriptionPlan === target ? 'RENEWAL' : state.subscriptionPlan === 'PRO' && target === 'BASIC' ? 'DOWNGRADE' : 'NEW',
    quotedPeriodExpiresAt: null, quotedMembershipUpdatedAt: state.subscriptionUpdatedAt };
}
