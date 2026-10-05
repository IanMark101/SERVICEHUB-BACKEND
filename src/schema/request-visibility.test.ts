import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOfferTarget } from '../services/offer-eligibility';

test('a public request stays available to any provider despite obsolete provider-only metadata', () => {
  for (const targetProviderId of [null, 'old-provider-a', 'old-provider-b']) {
    for (const providerId of ['provider-a', 'provider-b', 'provider-c']) {
      assert.doesNotThrow(() => assertOfferTarget({ targetProviderId, targetServiceId: null }, providerId));
    }
  }
});

test('listing inquiries retain both their provider and selected-listing restrictions', () => {
  const inquiry = { targetProviderId: 'chosen-provider', targetServiceId: 'selected-listing' };
  assert.doesNotThrow(() => assertOfferTarget(inquiry, 'chosen-provider', 'selected-listing'));
  assert.throws(() => assertOfferTarget(inquiry, 'other-provider', 'selected-listing'), (error: any) => error.code === 'REQUEST_RESERVED');
  assert.throws(() => assertOfferTarget(inquiry, 'chosen-provider'), (error: any) => error.code === 'REQUEST_LISTING_REQUIRED');
  assert.throws(() => assertOfferTarget({ ...inquiry, targetProviderId: null }, 'other-provider', 'selected-listing'), (error: any) => error.code === 'REQUEST_RESERVED');
});
