import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestUrgencySchema, ServiceRequestSchema, ServiceRequestUpdateSchema } from './marketplace.schema';

const request = { categoryId: 'ckx1234567890123456789012', title: 'Repair kitchen faucet', description: 'Please fix the leaking kitchen faucet.', budgetMin: 150, budgetMax: 500, paymentMethods: { cash: true, gcash: false } };

test('request creation and urgency edits accept only the five controlled choices', () => {
  for (const urgency of ['ASAP / Today', 'Needs Tomorrow', 'Next 1-2 Days', 'This Week', 'Flexible Schedule']) {
    assert.equal(ServiceRequestSchema.parse({ ...request, urgency }).urgency, urgency);
    assert.equal(ServiceRequestUpdateSchema.parse({ urgency }).urgency, urgency);
  }
});

test('missing, arbitrary and legacy free-text urgency cannot be newly submitted', () => {
  for (const urgency of [undefined, null, '', 'adsfasdfadsf', 'Monday', 'high', 'Flexible', 'ASAP / Today extra', 5]) {
    assert.equal(ServiceRequestSchema.safeParse({ ...request, urgency }).success, false);
    if (urgency !== undefined) assert.equal(ServiceRequestUpdateSchema.safeParse({ urgency }).success, false);
  }
  const invalid = RequestUrgencySchema.safeParse('random words');
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.match(invalid.error.issues[0].message, /Select a valid urgency/);
});

test('unrelated historical-request edits and status toggles do not require rewriting saved urgency', () => {
  assert.deepEqual(ServiceRequestUpdateSchema.parse({ description: 'Please repair our leaking kitchen faucet.' }), { description: 'Please repair our leaking kitchen faucet.' });
  assert.deepEqual(ServiceRequestUpdateSchema.parse({ status: 'OPEN' }), { status: 'OPEN' });
});
