import assert from 'node:assert/strict';
import test from 'node:test';
import { assertListingCapacity, oneCalendarMonthFrom, subscriptionBenefits, type SubscriptionState } from '../services/subscription-policy';
import { paymentCommission } from '../services/payment-commission';
import { selectFeaturedServices } from '../services/featured-services.service';

const now = new Date('2026-10-20T08:00:00Z');
const free: SubscriptionState = { subscriptionPlan: 'FREE', subscriptionStatus: 'ACTIVE', subscriptionStartedAt: null, subscriptionExpiresAt: null };
const pro: SubscriptionState = { subscriptionPlan: 'PRO', subscriptionStatus: 'ACTIVE', subscriptionStartedAt: new Date('2026-10-05T08:00:00Z'), subscriptionExpiresAt: new Date('2026-11-05T08:00:00Z') };
test('Free has three active listings and a 10% fee; Pro is unlimited with 5%', () => {
  assert.equal(subscriptionBenefits(free, now).activeListingLimit, 3);
  assert.doesNotThrow(() => assertListingCapacity(free, 2, now));
  assert.throws(() => assertListingCapacity(free, 3, now), /3-service listing limit/);
  assert.doesNotThrow(() => assertListingCapacity(pro, 100, now));
  assert.equal(paymentCommission(1000, subscriptionBenefits(free, now).commissionRateBps).providerNetAmount.toNumber(), 900);
  assert.equal(paymentCommission(1000, subscriptionBenefits(pro, now).commissionRateBps).providerNetAmount.toNumber(), 950);
});
test('cancelled subscriptions keep benefits through the paid period; expiry is exact', () => {
  assert.equal(subscriptionBenefits({ ...pro, subscriptionStatus: 'CANCELLED' }, now).plan, 'PRO');
  assert.equal(subscriptionBenefits(pro, pro.subscriptionExpiresAt!).plan, 'FREE');
  assert.equal(subscriptionBenefits({ ...pro, subscriptionStatus: 'EXPIRED' }, now).plan, 'FREE');
  assert.equal(subscriptionBenefits({ ...pro, subscriptionStartedAt: new Date('2027-01-01') }, now).plan, 'FREE');
  assert.throws(() => assertListingCapacity(pro, 8, new Date('2026-12-01')), /listing limit/);
});
test('one month clamps the day and keeps time, including leap years', () => {
  for (const [start, end] of [['2026-01-31T08:15:00Z', '2026-02-28T08:15:00.000Z'], ['2028-01-31T08:15:00Z', '2028-02-29T08:15:00.000Z'], ['2026-12-20T08:15:00Z', '2027-01-20T08:15:00.000Z'], ['2026-01-30T20:15:00Z', '2026-02-27T20:15:00.000Z'], ['2026-01-31T20:15:00Z', '2026-02-28T20:15:00.000Z']]) {
    assert.equal(oneCalendarMonthFrom(new Date(start)).toISOString(), end);
  }
});
test('featured boost helps similar eligible providers, never poor-quality Pro; it expires', () => {
  const candidate = (id: string, state: SubscriptionState, trust: number, rating: number) => ({ id, providerId: id, publishedAt: now,
    provider: { ...state, trustScore: trust }, reviews: [{ targetId: id, rating }] });
  const listings = [candidate('free', free, 90, 5), candidate('pro', pro, 90, 5), candidate('poor-pro', pro, 50, 2), candidate('excellent-free', free, 100, 5)];
  assert.deepEqual(selectFeaturedServices(listings, 6, now).map(item => item.id), ['excellent-free', 'pro', 'free']);
  assert.deepEqual(selectFeaturedServices(listings, 6, new Date('2026-12-01')).map(item => item.id), ['excellent-free', 'free', 'pro']);
  assert.equal(selectFeaturedServices([{ ...listings[1]!, reviews: [] }], 6, now).length, 0);
});
