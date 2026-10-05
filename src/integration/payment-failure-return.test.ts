import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { initiateOnlinePayment, reconcileOnlinePaymentReturn } from '../services/payment-attempt.service';

test('a failed GCash source is retired, retry gets a fresh redirect, and only the paid retry creates one queue booking', async (t) => {
  const suffix = randomUUID();
  const provider = await prisma.user.create({ data: {
    name: 'Payment Retry Provider', email: `retry-provider-${suffix}@example.test`, passwordHash: 'test-only',
    phone: 'test-only', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const seeker = await prisma.user.create({ data: {
    name: 'Payment Retry Seeker', email: `retry-seeker-${suffix}@example.test`, passwordHash: 'test-only',
    phone: 'test-only', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const category = await prisma.category.create({ data: { name: `Retry ${suffix}` } });
  const service = await prisma.service.create({ data: {
    providerId: provider.id, categoryId: category.id, title: `Retry service ${suffix}`,
    titleNormalized: `retry service ${suffix}`, description: 'GCash failure and retry regression service.',
    price: 70, estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { gcash: true, cash: true },
    status: 'ACTIVE', isAvailable: true,
  } });
  const failedIntentId = `pi_failed_${suffix}`;
  const freshIntentId = `pi_fresh_${suffix}`;
  const failed = await prisma.paymentAttempt.create({ data: {
    idempotencyKey: `retry-old-${suffix}`, seekerId: seeker.id, providerId: provider.id,
    serviceId: service.id, providerIntentId: failedIntentId,
    redirectUrl: `https://test-sources.paymongo.com/sources/expired-${suffix}`,
    amount: 70, paymentMethod: 'gcash', expiresAt: new Date(Date.now() + 120_000),
  } });
  const savedFetch = globalThis.fetch;
  let freshSucceeded = false;
  let returnUrl = '';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (url.endsWith(`/payment_intents/${failedIntentId}`)) {
      return Response.json({ data: { id: failedIntentId, attributes: { status: 'awaiting_payment_method', amount: 7000, currency: 'PHP' } } });
    }
    if (url.endsWith('/payment_intents') && method === 'POST') {
      return Response.json({ data: { id: freshIntentId, attributes: { client_key: `client_${suffix}`, status: 'awaiting_payment_method' } } });
    }
    if (url.endsWith('/payment_methods') && method === 'POST') {
      return Response.json({ data: { id: `pm_${suffix}` } });
    }
    if (url.endsWith(`/payment_intents/${freshIntentId}/attach`)) {
      const payload = JSON.parse(String(init?.body));
      returnUrl = payload.data.attributes.return_url;
      return Response.json({ data: { attributes: {
        status: 'awaiting_next_action', next_action: { type: 'redirect', redirect: { url: `https://test-sources.paymongo.com/sources/fresh-${suffix}` } },
      } } });
    }
    if (url.endsWith(`/payment_intents/${freshIntentId}`)) {
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { providerIntentId: freshIntentId } });
      return Response.json({ data: { id: freshIntentId, attributes: {
        status: freshSucceeded ? 'succeeded' : 'awaiting_next_action', amount: 7000, currency: 'PHP',
        payments: freshSucceeded ? [{ id: `pay_${suffix}` }] : [],
        metadata: {
          servicehub_attempt_id: attempt.id, servicehub_seeker_id: seeker.id,
          servicehub_service_id: service.id, servicehub_offer_id: '',
          servicehub_expected_amount: '70.00', servicehub_payment_method: 'gcash',
        },
      } } });
    }
    throw new Error(`Unexpected PayMongo test request: ${method} ${url}`);
  };
  t.after(async () => {
    globalThis.fetch = savedFetch;
    await prisma.notification.deleteMany({ where: { userId: { in: [provider.id, seeker.id] } } });
    await prisma.queue.deleteMany({ where: { serviceId: service.id } });
    await prisma.booking.deleteMany({ where: { serviceId: service.id } });
    await prisma.paymentAttempt.deleteMany({ where: { seekerId: seeker.id, serviceId: service.id } });
    await prisma.service.delete({ where: { id: service.id } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.user.deleteMany({ where: { id: { in: [provider.id, seeker.id] } } });
    await prisma.$disconnect();
  });

  assert.equal((await reconcileOnlinePaymentReturn(seeker.id, failedIntentId)).status, 'FAILED');
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: failed.id } })).status, 'FAILED');
  assert.equal(await prisma.booking.count({ where: { serviceId: service.id } }), 0);
  assert.equal(await prisma.queue.count({ where: { serviceId: service.id } }), 0);

  const fresh = await initiateOnlinePayment({ seekerId: seeker.id, serviceId: service.id, paymentMethod: 'gcash' });
  assert.notEqual(fresh.id, failed.id);
  assert.equal(fresh.providerIntentId, freshIntentId);
  assert.notEqual(fresh.redirectUrl, failed.redirectUrl);
  const parsedReturnUrl = new URL(returnUrl);
  assert.equal(parsedReturnUrl.pathname, '/seeker/payment-return');
  assert.equal(parsedReturnUrl.searchParams.get('payment_intent_id'), freshIntentId);
  assert.equal((await reconcileOnlinePaymentReturn(seeker.id, freshIntentId)).status, 'PENDING');
  assert.equal(await prisma.booking.count({ where: { serviceId: service.id } }), 0);

  freshSucceeded = true;
  assert.equal((await reconcileOnlinePaymentReturn(seeker.id, freshIntentId)).status, 'SUCCEEDED');
  assert.equal((await reconcileOnlinePaymentReturn(seeker.id, freshIntentId)).status, 'SUCCEEDED');
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: fresh.id } }), 1);
  assert.equal(await prisma.queue.count({ where: { serviceId: service.id, status: 'WAITING' } }), 1);
});
