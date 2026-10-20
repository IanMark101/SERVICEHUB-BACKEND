import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { paymentReturnCheckout } from '../services/payment-return-details';
import type { getPaymentAttemptStatus } from '../services/payment-attempt.service';

const attempt: Awaited<ReturnType<typeof getPaymentAttemptStatus>> = {
  id: 'attempt-one', status: 'SUCCEEDED', amount: new Prisma.Decimal(500), failureReason: null, expiresAt: new Date(), quantity: 1,
  commissionRateBps: 1000, platformFeeAmount: new Prisma.Decimal(50), providerNetAmount: new Prisma.Decimal(450),
  isTestMode: true, paidAt: new Date('2026-10-20T08:00:00Z'), providerPaymentId: 'pay-one', serviceId: 'service-one', offerId: null,
};
const fakeDb = (findFirst: (query: any) => Promise<unknown>) => ({ booking: { findFirst } }) as unknown as Parameters<typeof paymentReturnCheckout>[3];

test('verified receipt restores exact server amounts and queries only its owner booking', async () => {
  const result = await paymentReturnCheckout('customer-one', 'pi_one', attempt, fakeDb(async query => {
    assert.deepEqual(query.where, { paymentAttemptId: 'attempt-one', seekerId: 'customer-one' });
    return { id: 'booking-one', service: { title: 'Math tutoring' }, offer: null, provider: { name: 'Provider name' } };
  }));
  assert.deepEqual(result, {
    seekerId: 'customer-one', paymentIntentId: 'pi_one', serviceId: 'service-one', offerId: undefined, quantity: 1,
    expectedAmount: 500, commission: { ratePercent: 10, platformFeeAmount: 50, providerNetAmount: 450 },
    isTestMode: true, paidAt: attempt.paidAt, reference: 'pay-one', bookingId: 'booking-one', title: 'Math tutoring', providerName: 'Provider name',
  });
});

test('pending, failed and refund states do not read or invent a confirmed booking', async () => {
  for (const status of ['PENDING', 'FAILED', 'EXPIRED', 'REFUND_REQUIRED', 'REFUNDED'] as const) {
    const result = await paymentReturnCheckout('customer-one', 'pi_one', { ...attempt, status, paidAt: null, providerPaymentId: null }, fakeDb(async () => { throw Error('No booking lookup before success'); }));
    assert.equal(result.bookingId, undefined);
    assert.equal(result.paidAt, null);
    assert.equal(result.reference, 'pi_one');
  }
});

test('custom offers use their request title and deleted bookings retain financial receipt without an invented link', async () => {
  const fromOffer = await paymentReturnCheckout('customer-one', 'pi_one', { ...attempt, serviceId: null, offerId: 'offer-one' }, fakeDb(async () => ({ id: 'booking-offer', service: null, offer: { request: { title: 'Fan repair' } }, provider: { name: 'Repair provider' } })));
  assert.equal(fromOffer.title, 'Fan repair');
  const archived = await paymentReturnCheckout('customer-one', 'pi_one', attempt, fakeDb(async () => null));
  assert.equal(archived.bookingId, undefined);
  assert.equal(archived.expectedAmount, 500);
});
