import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateServiceSchema } from './services.schema';

const listing = { serviceLocation: { latitude: 10.3, longitude: 123.9, label: 'Cebu' },
  categoryId: 'category-id',
  title: 'House cleaning service',
  description: 'I will clean the home and bring basic cleaning supplies.',
  price: 500,
  priceType: 'FIXED' as const,
  estimatedDurationMins: 90,
};

test('listing supports only the two approved payment methods, with at least one selected', () => {
  for (const paymentMethods of [
    { cash: true, gcash: false },
    { cash: false, gcash: true },
    { cash: true, gcash: true },
  ]) {
    assert.equal(CreateServiceSchema.safeParse({ ...listing, paymentMethods }).success, true);
  }
  assert.equal(CreateServiceSchema.safeParse({ ...listing, paymentMethods: { cash: false, gcash: false } }).success, false);
  assert.equal(CreateServiceSchema.safeParse({ ...listing, paymentMethods: { cash: true, gcash: false, card: true } }).success, false);
});
