import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { initiateOnlinePayment, finalizeSuccessfulPayment } from '../services/payment-attempt.service';
import { providerStartJob } from '../services/bookings/provider-operations.service';
import { markJobComplete, confirmCompletionService } from '../services/bookings/completion.service';
import { refundBookingPayment } from '../services/payment-refund.service';
import { platformEarningsSql } from '../services/platform-earnings.service';
import { PlatformEarningsQuerySchema } from '../schema/platform-earnings.schema';
import { createDirectRequest, respondToDirectBookingService } from '../services/bookings/direct-bookings.service';

test('new GCash fees settle once, full refunds reverse pending fees, and cash stays unchanged', async () => {
  // The migration harness creates and drops a disposable development schema.
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_/);
  const suffix = Date.now().toString();
  const category = await prisma.category.findFirstOrThrow();
  const createUser = (name: string, role = 'user') => prisma.user.create({ data: {
    name, email: `${name}-${suffix}@example.test`, phone: `09${suffix.slice(-9)}`, passwordHash: 'fixture-only', location: 'Cordova', role, emailVerified: true, verificationStatus: 'APPROVED', moderationStatus: 'ACTIVE',
  } });
  const customer = await createUser('commission-customer');
  const provider = await createUser('commission-provider');
  const admin = await createUser('commission-admin', 'admin');
  const createService = (cash: boolean) => prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Commission ${cash ? 'cash' : 'online'} ${suffix}`, titleNormalized: `commission-${cash}-${suffix}`, description: 'Disposable commission test service', price: 1000, priceType: 'FIXED', serviceType: 'ONE_TIME', estimatedDurationMins: 60, paymentMethods: { cash, gcash: !cash }, status: 'ACTIVE', isAvailable: true, serviceLocationMode: 'REMOTE' } });
  const online = await createService(false);
  const cash = await createService(true);
  const originalFetch = globalThis.fetch;
  const originalKey = env.PAYMONGO_SECRET_KEY;
  const originalWebhook = env.PAYMONGO_WEBHOOK_SECRET;
  env.PAYMONGO_SECRET_KEY = 'sk_test_commission_fixture';
  env.PAYMONGO_WEBHOOK_SECRET = 'whsk_commission_fixture_only';
  const intents = new Map<string, any>();
  let count = 0;
  globalThis.fetch = (async (input: any, options: any = {}) => {
    const url = String(input);
    assert.ok(url.startsWith('https://api.paymongo.com/v1/'), 'Never contact external services');
    if (url.endsWith('/payment_intents') && options.method === 'POST') {
      const attributes = JSON.parse(options.body).data.attributes;
      const id = `pi_commission_${++count}_${suffix}`;
      assert.equal(attributes.amount, 100000, 'Charge the original gross in centavos');
      intents.set(id, attributes);
      return Response.json({ data: { id, attributes: { client_key: 'fixture-client', status: 'awaiting_payment_method' } } });
    }
    if (url.endsWith('/payment_methods')) return Response.json({ data: { id: 'pm_fixture' } });
    if (url.endsWith('/attach')) return Response.json({ data: { attributes: { status: 'awaiting_next_action', next_action: { redirect: { url: 'https://test-sources.paymongo.com/fixture' } } } } });
    const id = url.split('/').at(-1)!;
    if (intents.has(id)) return Response.json({ data: { id, attributes: { ...intents.get(id), status: 'succeeded', payments: [{ id: `pay_${id}` }] } } });
    throw new Error('Unexpected gateway request');
  }) as typeof fetch;
  async function pay() {
    const attempt = await initiateOnlinePayment({ seekerId: customer.id, serviceId: online.id, paymentMethod: 'gcash', serviceLocationMode: 'REMOTE' });
    assert.equal(Number(attempt.platformFeeAmount), 100);
    assert.equal(Number(attempt.providerNetAmount), 900);
    const params = { paymentIntentId: attempt.providerIntentId!, paymentId: `pay_${attempt.providerIntentId}`, amount: 1000, currency: 'PHP', metadata: intents.get(attempt.providerIntentId!).metadata };
    const paid = await finalizeSuccessfulPayment(params);
    assert.ok(paid.booking);
    const replay = await finalizeSuccessfulPayment(params);
    assert.equal(replay.created, false);
    return paid.booking!;
  }
  async function report() {
    const [result] = await prisma.$queryRaw<any[]>(platformEarningsSql(PlatformEarningsQuerySchema.parse({})));
    return result;
  }
  try {
    const booking = await pay();
    assert.equal((await report()).summary.earnedTotal, 0);
    assert.equal((await report()).summary.pendingFees, 100);
    await providerStartJob(booking.id, provider.id);
    await markJobComplete(booking.id, provider.id);
    await confirmCompletionService(booking.id, customer.id);
    await confirmCompletionService(booking.id, customer.id);
    const earned = await prisma.transaction.findUniqueOrThrow({ where: { idempotencyKey: `booking-completion:${booking.id}` } });
    assert.equal(Number(earned.amount), 900);
    assert.equal((await report()).summary.earnedTotal, 100);
    const refundable = await pay();
    await refundBookingPayment(refundable.id, admin.id, 'Fixture full refund');
    await refundBookingPayment(refundable.id, admin.id, 'Duplicate fixture refund');
    const summary = await report();
    assert.equal(summary.summary.earnedTotal, 100);
    assert.equal(summary.summary.pendingFees, 0);
    assert.equal(summary.items.find((item: any) => item.bookingId === refundable.id).status, 'refunded');
    const direct = await createDirectRequest({ seekerId: customer.id, providerId: provider.id, serviceId: cash.id });
    const accepted = await respondToDirectBookingService(direct.id, provider.id, true);
    await providerStartJob(accepted.id, provider.id);
    await markJobComplete(accepted.id, provider.id);
    await confirmCompletionService(accepted.id, customer.id);
    const cashCompletion = await prisma.completedService.findUniqueOrThrow({ where: { bookingId: accepted.id } });
    assert.equal(Number(cashCompletion.providerNetAmount), 1000);
    assert.equal(Number(cashCompletion.platformFeeAmount), 0);
    assert.equal(await prisma.transaction.count({ where: { idempotencyKey: `booking-completion:${accepted.id}` } }), 0);
    assert.equal((await report()).period.transactions, 2);
    const filtered = await prisma.$queryRaw<any[]>(platformEarningsSql(PlatformEarningsQuerySchema.parse({ status: 'refunded', limit: 1, page: 99 })));
    assert.equal(filtered[0].pagination.total, 1);
    assert.equal(filtered[0].pagination.page, 1);
  } finally {
    globalThis.fetch = originalFetch; env.PAYMONGO_SECRET_KEY = originalKey; env.PAYMONGO_WEBHOOK_SECRET = originalWebhook;
    await prisma.$disconnect();
  }
});
