import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { CreateServiceSchema, UpdateServiceSchema } from './services.schema';
import { ListingInquirySchema } from './marketplace.schema';
import { calculateDirectListingTerms } from '../services/bookings/direct-listing-pricing';

const base = { categoryId: 'cmu1234560000000000000001', title: 'LAPTOP REPAIR SERVICE', description: 'I diagnose and repair laptop hardware problems.', estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: true }, serviceLocation: { latitude: 10.26, longitude: 123.95, label: 'Cordova' } };
test('price by agreement accepts no amount; set prices remain required and legacy modes stay unsupported', () => {
  for (const price of [undefined, null]) assert.equal(CreateServiceSchema.parse({ ...base, priceType: 'BY_AGREEMENT', price }).price, null);
  assert.equal(CreateServiceSchema.safeParse({ ...base, priceType: 'BY_AGREEMENT', price: 2500 }).success, false);
  for (const priceType of ['FIXED', 'PER_HOUR', 'PER_DAY', 'PER_PROJECT']) {
    assert.equal(CreateServiceSchema.safeParse({ ...base, priceType, price: null }).success, false);
    assert.equal(CreateServiceSchema.safeParse({ ...base, priceType, price: 2500 }).success, true);
  }
  for (const priceType of ['CUSTOM', 'STARTS_AT']) assert.equal(CreateServiceSchema.safeParse({ ...base, priceType, price: null }).success, false);
  assert.equal(UpdateServiceSchema.safeParse({ priceType: 'BY_AGREEMENT', price: null }).success, true);
  assert.equal(UpdateServiceSchema.safeParse({ priceType: 'FIXED', price: null }).success, false);
});
test('inquiry payload cannot supply a provider, price, payment, budget or public posting fields', () => {
  const inquiry = { serviceId: base.categoryId, message: 'The laptop does not turn on.', serviceLocationMode: 'SEEKER_VISITS' };
  assert.equal(ListingInquirySchema.safeParse(inquiry).success, true);
  for (const data of [{ ...inquiry, providerId: 'other' }, { ...inquiry, price: 0 }, { ...inquiry, paymentMethods: { cash: true, gcash: true } }, { ...inquiry, budgetMax: 0 }, { ...inquiry, title: 'Public post' }, { ...inquiry, message: 'short' }]) assert.equal(ListingInquirySchema.safeParse(data).success, false);
});
test('an agreement listing can never supply a direct booking/payment amount', () => {
  assert.throws(() => calculateDirectListingTerms('BY_AGREEMENT', null, 1, 60), /price confirmation/);
  assert.throws(() => calculateDirectListingTerms('BY_AGREEMENT', new Prisma.Decimal(2500), 1, 60), /price confirmation/);
  assert.equal(calculateDirectListingTerms('FIXED', new Prisma.Decimal(2500), 1, 60).amount.toNumber(), 2500);
});
