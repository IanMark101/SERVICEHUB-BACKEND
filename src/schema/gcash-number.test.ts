import assert from 'node:assert/strict';
import test from 'node:test';
import { UpdateGCashNumberSchema } from './gcash-number.schema';

test('private GCash preferences normalize valid PH numbers and support deliberate removal', () => {
  for (const number of ['09123456789', '+639123456789', ' 0912 345 6789 ', '+63 912-345-6789']) {
    assert.deepEqual(UpdateGCashNumberSchema.parse({ gcashNumber: number }), { gcashNumber: '09123456789' });
  }
  assert.deepEqual(UpdateGCashNumberSchema.parse({ gcashNumber: null }), { gcashNumber: null });
});
test('invalid numbers, owner IDs, contact phone mutations and missing inputs fail', () => {
  for (const input of [{}, { gcashNumber: '' }, { gcashNumber: '0912345678' }, { gcashNumber: '08123456789' }, { gcashNumber: 9123456789 }, { gcashNumber: '0912abc6789' }, { gcashNumber: '09123456789', userId: 'other' }, { gcashNumber: '09123456789', phone: '09111111111' }, { gcashNumber: '09123456789', mpin: '1234' }]) {
    assert.equal(UpdateGCashNumberSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});
