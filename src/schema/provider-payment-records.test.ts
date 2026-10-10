import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderPaymentRecordsQuerySchema } from './provider-payment-records.schema';
import { providerPaymentRecordsSql } from '../services/provider-payment-records.service';

test('provider history defaults to bounded server pagination and accepts a calendar date', () => {
  assert.deepEqual(ProviderPaymentRecordsQuerySchema.parse({}), { page: 1, limit: 8, status: 'all' });
  assert.equal(ProviderPaymentRecordsQuerySchema.parse({ date: '2026-10-10', status: 'refunded' }).date, '2026-10-10');
});

test('invalid dates, unbounded pages and unknown statuses fail validation', () => {
  for (const query of [{ date: '2026-02-30' }, { date: '2026-10-10T00:00:00Z' }, { page: 0 }, { limit: 51 }, { status: 'pending' }]) {
    assert.equal(ProviderPaymentRecordsQuerySchema.safeParse(query).success, false);
  }
});

test('a caller cannot select a different provider through query fields', () => {
  assert.equal(ProviderPaymentRecordsQuerySchema.safeParse({ providerId: 'another-member' }).success, false);
  assert.equal(ProviderPaymentRecordsQuerySchema.safeParse({ walletOwnerId: 'another-member' }).success, false);
});

test('provider and booking identifiers remain bound SQL parameters', () => {
  const attacker = "member' OR 1=1 --";
  const booking = "booking'; DELETE FROM users; --";
  const query = providerPaymentRecordsSql(attacker, ProviderPaymentRecordsQuerySchema.parse({ booking }));
  assert.equal(query.text.includes(attacker), false);
  assert.equal(query.text.includes(booking), false);
  assert.ok(query.values.includes(attacker));
  assert.ok(query.values.includes(booking));
});
