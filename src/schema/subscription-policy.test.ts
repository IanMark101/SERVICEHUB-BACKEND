import assert from 'node:assert/strict';
import test from 'node:test';
import { assertListingCapacity, assertMembershipAccess, oneCalendarMonthFrom, subscriptionBenefits, membershipQuote, FREE_PERIOD_MS, type SubscriptionState } from '../services/subscription-policy';
import { paymentCommission } from '../services/payment-commission';
import { selectFeaturedServices } from '../services/featured-services.service';

const now = new Date('2026-10-20T08:00:00Z');
const free: SubscriptionState = { subscriptionPlan: 'FREE', subscriptionStatus: 'ACTIVE', subscriptionStartedAt: null, subscriptionExpiresAt: null,
  freePlanStartedAt: new Date('2026-10-05T08:00:00Z'), freePlanExpiresAt: new Date('2026-11-04T08:00:00Z') };
const pro: SubscriptionState = { ...free, subscriptionPlan: 'PRO', subscriptionStartedAt: new Date('2026-10-05T08:00:00Z'), subscriptionExpiresAt: new Date('2026-11-05T08:00:00Z') };
const basic: SubscriptionState = { ...pro, subscriptionPlan: 'BASIC' };
for (const [plan, state, limit, fee, price] of [['Free', free, 1, 1000, 0], ['Basic', basic, 3, 800, 99], ['Pro', pro, null, 500, 199]] as const) {
  test(`${plan}: active access, correct capacity, exact fee and monthly price`, () => {
    const benefits = subscriptionBenefits(state, now);
    assert.equal(benefits.marketplaceAccess, true); assert.equal(benefits.activeListingLimit, limit);
    assert.equal(benefits.monthlyPrice, price); assert.equal(benefits.commissionRateBps, fee);
    assert.equal(paymentCommission(1000, fee).providerNetAmount.toNumber(), 1000 - fee / 10);
    if (limit === null) assert.doesNotThrow(() => assertListingCapacity(state, 100, now));
    else { assert.doesNotThrow(() => assertListingCapacity(state, limit - 1, now)); assert.throws(() => assertListingCapacity(state, limit, now), /active listing/); }
  });
  test(`${plan}: exact expiry blocks new business without erasing the stored plan`, () => {
    const expiry = plan === 'Free' ? state.freePlanExpiresAt! : state.subscriptionExpiresAt!;
    assert.equal(subscriptionBenefits(state, new Date(expiry.getTime() - 1)).marketplaceAccess, true);
    const ended = subscriptionBenefits(state, expiry);
    assert.equal(ended.marketplaceAccess, false); assert.equal(ended.plan, state.subscriptionPlan);
    assert.equal(ended.fullAnalytics, false); assert.equal(ended.featuredPriority, false);
    assert.throws(() => assertMembershipAccess(state, expiry), /Existing bookings remain available/);
  });
}
test('Free is exactly thirty elapsed days and can never silently restart', () => {
  assert.equal(FREE_PERIOD_MS, 30 * 86_400_000);
  assert.equal(subscriptionBenefits({ ...free, freePlanStartedAt: null, freePlanExpiresAt: null }, now).marketplaceAccess, false);
  assert.equal(subscriptionBenefits({ ...free, freePlanStartedAt: new Date(now.getTime() + 1) }, now).marketplaceAccess, false);
  assert.equal(subscriptionBenefits(free, now).fullAnalytics, false);
});
test('cancelled Basic and Pro retain paid benefits only until expiry', () => {
  for (const state of [basic, pro]) {
    assert.equal(subscriptionBenefits({ ...state, subscriptionStatus: 'CANCELLED' }, now).marketplaceAccess, true);
    assert.equal(subscriptionBenefits({ ...state, subscriptionStatus: 'CANCELLED' }, state.subscriptionExpiresAt!).marketplaceAccess, false);
    assert.equal(subscriptionBenefits({ ...state, subscriptionStatus: 'EXPIRED' }, now).marketplaceAccess, false);
  }
});
test('Basic to Pro charges only the remaining price difference and preserves expiry', () => {
  const midpoint = new Date((basic.subscriptionStartedAt!.getTime() + basic.subscriptionExpiresAt!.getTime()) / 2);
  const quote = membershipQuote({ ...basic, subscriptionUpdatedAt: now }, 'PRO', midpoint);
  assert.equal(quote.amount.toFixed(2), '50.00'); assert.equal(quote.billingAction, 'UPGRADE');
  assert.equal(quote.quotedPeriodExpiresAt, basic.subscriptionExpiresAt);
  assert.equal(membershipQuote({ ...basic, subscriptionUpdatedAt: now }, 'PRO', now).amount.toFixed(2), '51.61');
});
test('new and renewed paid periods charge the advertised price; no active duplicate or early downgrade', () => {
  assert.equal(membershipQuote({ ...free, subscriptionUpdatedAt: now }, 'BASIC', now).amount.toNumber(), 99);
  assert.equal(membershipQuote({ ...free, subscriptionUpdatedAt: now }, 'PRO', now).amount.toNumber(), 199);
  assert.throws(() => membershipQuote({ ...basic, subscriptionUpdatedAt: now }, 'BASIC', now), /already active/);
  assert.throws(() => membershipQuote({ ...pro, subscriptionUpdatedAt: now }, 'BASIC', now), /after that date/);
  const ended = new Date(pro.subscriptionExpiresAt!.getTime() + 1);
  assert.equal(membershipQuote({ ...pro, subscriptionUpdatedAt: now }, 'BASIC', ended).billingAction, 'DOWNGRADE');
  assert.equal(membershipQuote({ ...basic, subscriptionUpdatedAt: now }, 'BASIC', ended).billingAction, 'RENEWAL');
});
test('a sub-peso upgrade is not rounded up into a larger charge', () => {
  assert.throws(() => membershipQuote({ ...basic, subscriptionUpdatedAt: now }, 'PRO', new Date(basic.subscriptionExpiresAt!.getTime() - 1000)), /nearly over/);
});
test('calendar months clamp month-end in Philippine time, including leap years', () => {
  for (const [start, end] of [['2026-01-31T08:15:00Z', '2026-02-28T08:15:00.000Z'], ['2028-01-31T08:15:00Z', '2028-02-29T08:15:00.000Z'], ['2026-12-20T08:15:00Z', '2027-01-20T08:15:00.000Z'], ['2026-01-30T20:15:00Z', '2026-02-27T20:15:00.000Z']]) assert.equal(oneCalendarMonthFrom(new Date(start)).toISOString(), end);
});
test('featured placements require active Pro and quality; payment never buys Trust Score', () => {
  const candidate = (id: string, state: SubscriptionState, trust: number, rating: number) => ({ id, providerId: id, publishedAt: now, provider: { ...state, trustScore: trust }, reviews: [{ targetId: id, rating }] });
  const listings = [candidate('free', free, 100, 5), candidate('basic', basic, 100, 5), candidate('pro', pro, 90, 5), candidate('poor-pro', pro, 50, 2)];
  assert.deepEqual(selectFeaturedServices(listings, 6, now).map(item => item.id), ['pro']);
  assert.deepEqual(selectFeaturedServices(listings, 6, pro.subscriptionExpiresAt!).map(item => item.id), []);
  assert.equal(selectFeaturedServices([{ ...listings[2]!, reviews: [] }], 6, now).length, 0);
});
