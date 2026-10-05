import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { initiateOnlinePayment } from '../services/payment-attempt.service';
import { listReceivedOffers } from '../services/offers.service';

test('request selections persist and cash/GCash booking paths reject unchecked methods before payment', async (t) => {
  const suffix = randomUUID();
  const users = await Promise.all(['Seeker', 'Provider'].map(name => prisma.user.create({ data: {
    name: `Payment Choice ${name}`, email: `request-payment-${name}-${suffix}@example.test`, passwordHash: 'test-only',
    phone: 'test-only', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED',
  } })));
  const [seeker, provider] = users;
  const category = await prisma.category.create({ data: { name: `Request payment ${suffix}` } });
  const savedFetch = globalThis.fetch;
  const keys = { public: env.PAYMONGO_PUBLIC_KEY, secret: env.PAYMONGO_SECRET_KEY, webhook: env.PAYMONGO_WEBHOOK_SECRET };
  env.PAYMONGO_PUBLIC_KEY = 'pk_test_request_choice';
  env.PAYMONGO_SECRET_KEY = 'sk_test_request_choice';
  env.PAYMONGO_WEBHOOK_SECRET = 'whsec_test_request_choice';
  let gatewayCalls = 0;
  const intent = `pi_choice_${suffix}`;
  globalThis.fetch = async (input) => {
    gatewayCalls++;
    const url = String(input);
    if (url.endsWith('/payment_intents')) return Response.json({ data: { id: intent, attributes: { client_key: 'test-client-key', status: 'awaiting_payment_method' } } });
    if (url.endsWith('/payment_methods')) return Response.json({ data: { id: `pm_${suffix}` } });
    if (url.endsWith(`/payment_intents/${intent}/attach`)) return Response.json({ data: { attributes: { status: 'awaiting_next_action', next_action: { type: 'redirect', redirect: { url: `https://test-sources.paymongo.com/sources/${suffix}` } } } } });
    throw new Error('Unexpected test gateway request');
  };
  t.after(async () => {
    globalThis.fetch = savedFetch;
    env.PAYMONGO_PUBLIC_KEY = keys.public;
    env.PAYMONGO_SECRET_KEY = keys.secret;
    env.PAYMONGO_WEBHOOK_SECRET = keys.webhook;
    await prisma.booking.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.paymentAttempt.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.offer.deleteMany({ where: { providerId: provider.id } });
    await prisma.serviceRequest.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: users.map(user => user.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.$disconnect();
  });

  const offers = [];
  for (const paymentMethods of [{ cash: true, gcash: false }, { cash: false, gcash: true }, { cash: true, gcash: true }]) {
    const request = await prisma.serviceRequest.create({ data: {
      seekerId: seeker.id, categoryId: category.id, title: 'PIPE REPAIR', description: 'Repair the leaking pipe.',
      budgetMin: 500, budgetMax: 500, urgency: 'Flexible', paymentMethods,
    } });
    offers.push(await prisma.offer.create({ data: { requestId: request.id, providerId: provider.id, offeredPrice: 500, estimatedDuration: 60 } }));
    assert.deepEqual((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).paymentMethods, paymentMethods);
  }
  const [cashOnly, gcashOnly, both] = offers;
  const received = await listReceivedOffers(seeker.id);
  assert.deepEqual(received.find(offer => offer.id === cashOnly.id)?.request.paymentMethods, { cash: true, gcash: false });
  await assert.rejects(initiateOnlinePayment({ seekerId: seeker.id, offerId: cashOnly.id, paymentMethod: 'gcash' }), { code: 'REQUEST_PAYMENT_METHOD_UNAVAILABLE' });
  await assert.rejects(createDirectFromOfferService(gcashOnly.id, seeker.id), { code: 'REQUEST_PAYMENT_METHOD_UNAVAILABLE' });
  assert.equal(gatewayCalls, 0, 'unchecked methods never contact PayMongo');
  assert.equal(await prisma.booking.count({ where: { seekerId: seeker.id } }), 0);
  assert.equal(await prisma.paymentAttempt.count({ where: { seekerId: seeker.id } }), 0);

  const cashBooking = await createDirectFromOfferService(both.id, seeker.id);
  assert.equal(cashBooking.paymentMethod, 'On-site Cash');
  const online = await initiateOnlinePayment({ seekerId: seeker.id, offerId: gcashOnly.id, paymentMethod: 'gcash' });
  assert.equal(online.offerId, gcashOnly.id);
  assert.equal(online.status, 'PENDING');
  assert.ok(online.redirectUrl?.startsWith('https://test-sources.paymongo.com/'));
  assert.equal(gatewayCalls, 3);
  await assert.rejects(createDirectFromOfferService(gcashOnly.id, seeker.id), /no longer available/);
});
