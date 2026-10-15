import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { initiateOnlinePayment } from '../services/payment-attempt.service';
import { listReceivedOffers } from '../services/offers.service';

test('request selections persist and cash/GCash booking paths reject unchecked methods before payment', async (t) => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/, 'Run fresh-migrations with SERVICEHUB_GCASH_OFFER_ONLY=1');
  const suffix = randomUUID();
  const users = await Promise.all(['Seeker', 'Provider'].map(name => prisma.user.create({ data: {
    name: `Payment Choice ${name}`, email: `request-payment-${name}-${suffix}@example.test`, passwordHash: 'test-only',
    phone: 'test-only', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED',
  } })));
  const [seeker, provider] = users;
  const category = await prisma.category.create({ data: { name: `Request payment ${suffix}` } });
  const session = await prisma.refreshToken.create({ data: {
    userId: seeker.id, token: createHash('sha256').update(suffix).digest('hex'),
    expiresAt: new Date(Date.now() + 15 * 60_000),
  } });
  const token = jwt.sign({ sub: seeker.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const { port } = server.address() as AddressInfo;
  const savedFetch = globalThis.fetch;
  // Exercise the real authenticated HTTP route; only the external gateway is mocked.
  const postPayment = (body: Record<string, unknown>) => savedFetch(`http://127.0.0.1:${port}/api/bookings/initiate-payment`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const keys = { public: env.PAYMONGO_PUBLIC_KEY, secret: env.PAYMONGO_SECRET_KEY, webhook: env.PAYMONGO_WEBHOOK_SECRET };
  env.PAYMONGO_PUBLIC_KEY = 'pk_test_request_choice';
  env.PAYMONGO_SECRET_KEY = 'sk_test_request_choice';
  env.PAYMONGO_WEBHOOK_SECRET = 'whsec_test_request_choice';
  let gatewayCalls = 0;
  const intent = `pi_choice_${suffix}`;
  let gatewayAmount = 0;
  globalThis.fetch = async (input, options) => {
    gatewayCalls++;
    const url = String(input);
    if (url.endsWith('/payment_intents')) {
      gatewayAmount = JSON.parse(String(options?.body)).data.attributes.amount;
      return Response.json({ data: { id: intent, attributes: { client_key: 'test-client-key', status: 'awaiting_payment_method' } } });
    }
    if (url.endsWith('/payment_methods')) return Response.json({ data: { id: `pm_${suffix}` } });
    if (url.endsWith(`/payment_intents/${intent}/attach`)) return Response.json({ data: { attributes: { status: 'awaiting_next_action', next_action: { type: 'redirect', redirect: { url: `https://test-sources.paymongo.com/sources/${suffix}` } } } } });
    throw new Error('Unexpected test gateway request');
  };
  t.after(async () => {
    globalThis.fetch = savedFetch;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    env.PAYMONGO_PUBLIC_KEY = keys.public;
    env.PAYMONGO_SECRET_KEY = keys.secret;
    env.PAYMONGO_WEBHOOK_SECRET = keys.webhook;
    await prisma.booking.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.paymentAttempt.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.offer.deleteMany({ where: { providerId: provider.id } });
    await prisma.serviceRequest.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: users.map(user => user.id) } } });
    await prisma.refreshToken.delete({ where: { id: session.id } });
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
    offers.push(await prisma.offer.create({ data: { requestId: request.id, providerId: provider.id, offeredPrice: 2500, estimatedDuration: 60 } }));
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
  assert.equal(gcashOnly.serviceId, null, 'custom offers do not require a provider service listing');
  const invalid = await postPayment({ offerId: gcashOnly.id, serviceId: null, paymentMethodType: 'gcash' });
  assert.equal(invalid.status, 400, 'reproduce the old frontend payload at the real schema boundary');
  assert.equal(gatewayCalls, 0, 'invalid payload never starts a gateway charge');
  const response = await postPayment({ offerId: gcashOnly.id, paymentMethodType: 'gcash' });
  const body = await response.json() as { success: boolean; data: { expectedAmount: number; paymentIntentId: string; redirectUrl: string } };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data.expectedAmount, 2500, 'the server uses the accepted offer total');
  assert.equal(gatewayAmount, 250000, 'PayMongo receives the same amount in centavos');
  assert.equal(body.data.paymentIntentId, intent);
  assert.ok(body.data.redirectUrl.startsWith('https://test-sources.paymongo.com/'));
  const online = await prisma.paymentAttempt.findUniqueOrThrow({ where: { providerIntentId: intent } });
  assert.equal(online.offerId, gcashOnly.id);
  assert.equal(online.serviceId, null);
  assert.equal(online.status, 'PENDING');
  assert.equal(await prisma.booking.count({ where: { offerId: gcashOnly.id } }), 0, 'initiation alone must not create a paid booking');
  assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: gcashOnly.id } })).status, 'PENDING_PAYMENT');
  assert.equal(gatewayCalls, 3);
  await assert.rejects(createDirectFromOfferService(gcashOnly.id, seeker.id), /no longer available/);
});
