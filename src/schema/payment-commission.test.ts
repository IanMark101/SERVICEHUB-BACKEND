import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentCommission, commissionResponse } from '../services/payment-commission';
import { PlatformEarningsQuerySchema } from './platform-earnings.schema';
import { earningsDates } from '../services/platform-earnings.service';

test('commission rounds once to centavos and never changes the customer total', () => {
  for (const [gross, fee, net] of [['1000', '100', '900'], ['1100', '110', '990'], ['50.05', '5.01', '45.04'], ['49999.99', '5000', '44999.99']]) {
    const result = paymentCommission(gross);
    assert.equal(result.platformFeeAmount.toString(), fee);
    assert.equal(result.providerNetAmount.toString(), net);
    assert.equal(result.platformFeeAmount.plus(result.providerNetAmount).toString(), gross);
  }
  assert.deepEqual(commissionResponse({ amount: 1000 }), { ratePercent: 0, platformFeeAmount: 0, providerNetAmount: 1000 });
  assert.equal(paymentCommission(1000, 0).providerNetAmount.toNumber(), 1000);
  for (const value of [-1, 0, 10.005, Number.NaN]) assert.throws(() => paymentCommission(value));
});
test('earnings filters validate dates and use Philippine day and Monday week boundaries', () => {
  assert.equal(PlatformEarningsQuerySchema.safeParse({ period: 'custom', from: '2026-10-21', to: '2026-10-20' }).success, false);
  assert.equal(PlatformEarningsQuerySchema.safeParse({ period: 'custom', from: '2025-01-01', to: '2026-10-20' }).success, false);
  assert.equal(PlatformEarningsQuerySchema.safeParse({ period: 'custom', from: '2026-02-30', to: '2026-10-20' }).success, false);
  assert.equal(PlatformEarningsQuerySchema.safeParse({ status: 'arbitrary', page: 0 }).success, false);
  const dates = earningsDates(PlatformEarningsQuerySchema.parse({ period: 'week' }), new Date('2026-10-18T16:01:00Z'));
  assert.equal(dates.today, '2026-10-19');
  assert.equal(dates.from, '2026-10-19');
});
