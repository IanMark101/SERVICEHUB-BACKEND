import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceRequestSchema, ServiceRequestUpdateSchema } from './marketplace.schema';
import { assertRequestPaymentMethod, getRequestPaymentMethods } from '../services/request-payment-methods';

const request = { categoryId: 'ckx1234567890123456789012', title: 'Kitchen pipe repair', description: 'Repair the leaking pipe under the kitchen sink.', budgetMin: 500, budgetMax: 500, urgency: 'Flexible Schedule' };

test('new public requests require a strict, nonempty choice of payment methods', () => {
  for (const paymentMethods of [{ cash: true, gcash: false }, { cash: false, gcash: true }, { cash: true, gcash: true }]) {
    assert.deepEqual(ServiceRequestSchema.parse({ ...request, paymentMethods }).paymentMethods, paymentMethods);
    assert.deepEqual(ServiceRequestUpdateSchema.parse({ paymentMethods }).paymentMethods, paymentMethods);
  }
  for (const paymentMethods of [undefined, null, {}, { cash: false, gcash: false }, { cash: 'true', gcash: false }, { cash: true, gcash: false, card: true }]) {
    assert.equal(ServiceRequestSchema.safeParse({ ...request, paymentMethods }).success, false);
  }
  assert.equal(ServiceRequestUpdateSchema.safeParse({ paymentMethods: { cash: false, gcash: false } }).success, false);
});

test('booking guards reject an unchecked method and retain legacy/direct inquiry behavior', () => {
  for (const method of ['cash', 'gcash'] as const) {
    const paymentMethods = { cash: method === 'cash', gcash: method === 'gcash' };
    assert.doesNotThrow(() => assertRequestPaymentMethod({ paymentMethods }, method));
    assert.throws(() => assertRequestPaymentMethod({ paymentMethods }, method === 'cash' ? 'gcash' : 'cash'), { code: 'REQUEST_PAYMENT_METHOD_UNAVAILABLE', status: 409 });
  }
  assert.deepEqual(getRequestPaymentMethods({}), { cash: true, gcash: true });
  assert.deepEqual(getRequestPaymentMethods({ preferredPaymentMethod: 'GCash' }), { cash: false, gcash: true });
  assert.deepEqual(getRequestPaymentMethods({ preferredPaymentMethod: 'On-site Cash' }), { cash: true, gcash: false });
  assert.deepEqual(getRequestPaymentMethods({ paymentMethods: { cash: false, gcash: false } }), { cash: false, gcash: false });
});
