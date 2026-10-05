import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { initSocket } from '../lib/socket';
import { submitOffer, rejectOffer, listReceivedOffers } from '../services/offers.service';
import { createRequest, listRequests } from '../services/requests.service';
import { getMine, create as createOffer, reject as decideOffer } from '../controllers/offers.controller';
import { createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { initiateOnlinePayment, finalizeSuccessfulPayment, markPaymentAttemptFailed, expireStalePaymentAttempts } from '../services/payment-attempt.service';

// Run with scripts/run-independent-audit.ts; never create fixtures in the app schema.
test('offer submission, decisions, notification durability and payment lifecycle', async t => {
  const schema = new URL(env.DATABASE_URL).searchParams.get('schema') || '';
  assert.match(schema, /^audit_20260924_[a-f0-9]{32}$/);
  const suffix = randomUUID();
  const makeUser = (label: string, overrides = {}) => prisma.user.create({ data: {
    name: label, email: `${label.replaceAll(' ', '-').toLowerCase()}-${suffix}@example.test`, passwordHash: 'test-only-unusable-hash',
    phone: 'test-only', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED', ...overrides,
  } });
  const seeker = await makeUser('John Seeker');
  const provider = await makeUser('Ian Provider');
  const other = await makeUser('Other Provider');
  const category = await prisma.category.create({ data: { name: `Carpentry ${suffix}` } });
  const listing = await prisma.service.create({ data: {
    providerId: other.id, categoryId: category.id, title: 'Repair doors', titleNormalized: `repair doors ${suffix}`, description: 'Repair wooden doors and cabinets.',
    price: 150, status: 'ACTIVE', isAvailable: true, priceType: 'FIXED', estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: true },
  } });
  const makeRequest = (overrides = {}) => prisma.serviceRequest.create({ data: {
    seekerId: seeker.id, categoryId: category.id, title: 'NEED SOMEONE WHO CAN FIX OUR JAMMED DOOR', description: 'Please repair our jammed wooden door.', budgetMin: 150, budgetMax: 300, urgency: 'Saturday',
    paymentMethods: { cash: true, gcash: true }, ...overrides,
  } });
  const proposal = (requestId: string, serviceId?: string) => ({ requestId, serviceId, offeredPrice: 150, estimatedDuration: 60, availability: 'Saturday morning', message: 'I can repair your door.' });
  const events: Array<{ room: string; event: string; data: any }> = [];
  const io = initSocket(createServer());
  t.mock.method(io, 'to', (room: string) => ({ emit(event: string, data: any) { events.push({ room, event, data }); } }) as any);
  t.after(() => { io.close(); });
  const capture = async (controller: typeof getMine, userId: string, extra = {}) => {
    let body: any, status = 200, failure: unknown;
    await controller({ user: { id: userId }, ...extra } as any, { status(code: number) { status = code; return this; }, json(value: any) { body = value; return this; } } as any, error => { failure = error; });
    if (failure) throw failure;
    return { status, body };
  };
  const assertCode = (code: string) => (error: any) => error.code === code && error.message.length > 15;
  const mine = async (userId: string) => (await capture(getMine, userId)).body.data;

  await t.test('eligible provider needs no listing and can customize all offer fields', async () => {
    assert.equal(await prisma.service.count({ where: { providerId: provider.id } }), 0);
    const request = await makeRequest();
    const offer = await submitOffer(provider.id, proposal(request.id));
    assert.equal(offer.serviceId, null);
    assert.equal(offer.availability, 'Saturday morning');
    assert.equal(offer.status, 'PENDING');
    assert.equal(Number(offer.offeredPrice), 150);
    assert.equal(offer.estimatedDuration, 60);
    assert.ok(events.some(e => e.room === `user:${seeker.id}` && e.event === 'notification'));
    assert.ok(events.some(e => e.room === `user:${provider.id}` && e.event === 'OFFERS_CHANGED'));
  });
  await t.test('compatible active listing is an optional shortcut', async () => {
    const request = await makeRequest();
    assert.equal((await submitOffer(other.id, proposal(request.id, listing.id))).serviceId, listing.id);
  });
  await t.test('two eligible providers independently submit to a public request', async () => {
    const request = await makeRequest();
    const offers = await Promise.all([submitOffer(provider.id, proposal(request.id)), submitOffer(other.id, proposal(request.id))]);
    assert.notEqual(offers[0].id, offers[1].id);
    assert.equal(await prisma.offer.count({ where: { requestId: request.id } }), 2);
  });
  await t.test('public requests with null listing and payment fields allow every eligible provider', async () => {
    const request = await makeRequest({ targetProviderId: null, targetServiceId: null, preferredPaymentMethod: null, paymentMethods: Prisma.DbNull });
    assert.ok((await listRequests(undefined, provider.id)).some(item => item.id === request.id));
    const offer = await submitOffer(provider.id, proposal(request.id));
    assert.equal(offer.serviceId, null);
    assert.equal(offer.status, 'PENDING');
    assert.equal((await submitOffer(other.id, proposal(request.id))).serviceId, null);
    assert.ok((await listRequests(undefined, other.id)).some(item => item.id === request.id));
  });
  await t.test('paused or unrelated listings never prevent a listing-free offer', async () => {
    await prisma.service.update({ where: { id: listing.id }, data: { isAvailable: false } });
    const request = await makeRequest();
    await assert.rejects(submitOffer(other.id, proposal(request.id, listing.id)), assertCode('OFFER_LISTING_UNAVAILABLE'));
    assert.equal((await submitOffer(other.id, proposal(request.id))).serviceId, null);
    await prisma.service.update({ where: { id: listing.id }, data: { isAvailable: true } });
    await assert.rejects(submitOffer(provider.id, proposal((await makeRequest()).id, listing.id)), assertCode('OFFER_LISTING_UNAVAILABLE'));
  });
  await t.test('real listing inquiries preserve provider and exact listing restrictions', async () => {
    const request = await makeRequest({ targetProviderId: other.id, targetServiceId: listing.id, preferredPaymentMethod: 'On-site Cash' });
    await assert.rejects(submitOffer(provider.id, proposal(request.id)), assertCode('REQUEST_RESERVED'));
    await assert.rejects(submitOffer(other.id, proposal(request.id)), assertCode('REQUEST_LISTING_REQUIRED'));
    assert.equal((await submitOffer(other.id, proposal(request.id, listing.id))).status, 'PENDING');
  });
  await t.test('self-offers remain prohibited', async () => {
    await assert.rejects(submitOffer(seeker.id, proposal((await makeRequest()).id)), assertCode('SELF_TRANSACTION_NOT_ALLOWED'));
  });
  await t.test('banned, suspended, inactive, admin and unverified providers receive clear denials', async () => {
    const cases = [
      [{ moderationStatus: 'BANNED' }, 'ACCOUNT_BANNED'], [{ moderationStatus: 'SUSPENDED' }, 'ACCOUNT_SUSPENDED'],
      [{ isActive: false }, 'PARTICIPANT_INELIGIBLE'], [{ role: 'admin' }, 'PARTICIPANT_INELIGIBLE'],
      [{ emailVerified: false }, 'EMAIL_NOT_VERIFIED'], [{ verificationStatus: 'UNVERIFIED' }, 'VERIFICATION_REQUIRED'],
      [{ verificationStatus: 'PENDING_REVIEW' }, 'VERIFICATION_REQUIRED'],
    ] as const;
    for (const [fields, code] of cases) {
      const blocked = await makeUser(`Blocked ${randomUUID()}`, fields);
      await assert.rejects(submitOffer(blocked.id, proposal((await makeRequest()).id)), assertCode(code));
    }
  });
  await t.test('duplicate concurrent clicks commit only one offer and one seeker notification', async () => {
    const request = await makeRequest();
    const results = await Promise.allSettled([submitOffer(provider.id, proposal(request.id)), submitOffer(provider.id, proposal(request.id))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'DUPLICATE_OFFER');
    const offers = await prisma.offer.findMany({ where: { requestId: request.id } });
    assert.equal(offers.length, 1);
    assert.equal(await prisma.notification.count({ where: { link: `/seeker/incoming-offers?offer=${offers[0].id}` } }), 1);
  });
  await t.test('decline is atomic, durable offline, idempotent and visible on both refreshed interfaces', async () => {
    const request = await makeRequest();
    const offer = await submitOffer(provider.id, proposal(request.id));
    const before = events.length;
    const decisions = await Promise.all([rejectOffer(offer.id, seeker.id), rejectOffer(offer.id, seeker.id)]);
    assert.ok(decisions.every(item => item.status === 'REJECTED'));
    assert.equal((await listReceivedOffers(seeker.id)).find(item => item.id === offer.id)?.status, 'REJECTED');
    const refreshed = (await mine(provider.id)).find((item: any) => item.id === offer.id);
    assert.equal(refreshed.status, 'REJECTED');
    assert.equal(refreshed.decisionReason, 'DECLINED');
    const notification = await prisma.notification.findUniqueOrThrow({ where: { id: `offer-declined:${offer.id}` } });
    assert.equal(notification.userId, provider.id);
    assert.ok(notification.body.includes(request.title));
    assert.equal(notification.link, `/provider/provider-activity?tab=all&offer=${offer.id}`);
    assert.equal(await prisma.notification.count({ where: { id: `offer-declined:${offer.id}` } }), 1);
    assert.equal(events.slice(before).filter(e => e.room === `user:${provider.id}` && e.event === 'notification').length, 1);
    // No sockets were connected: persistence is independent of live delivery.
    assert.ok((await prisma.notification.findMany({ where: { userId: provider.id } })).some(item => item.id === notification.id));
  });
  await t.test('provider withdrawal has its own state, no decline notification and permits resubmission', async () => {
    const request = await makeRequest();
    const offer = await submitOffer(provider.id, proposal(request.id));
    const response = await capture(decideOffer, provider.id, { params: { id: offer.id } });
    assert.equal(response.body.data.status, 'WITHDRAWN');
    assert.equal(response.body.message, 'Offer withdrawn');
    assert.equal((await rejectOffer(offer.id, provider.id)).status, 'WITHDRAWN');
    assert.equal(await prisma.notification.count({ where: { id: `offer-declined:${offer.id}` } }), 0);
    assert.equal((await mine(provider.id)).find((item: any) => item.id === offer.id).status, 'WITHDRAWN');
    assert.notEqual((await submitOffer(provider.id, proposal(request.id))).id, offer.id);
  });
  await t.test('closed requests and unauthorized offer decisions remain blocked', async () => {
    await assert.rejects(submitOffer(provider.id, proposal((await makeRequest({ status: 'CLOSED' })).id)), /paused or closed/);
    const offer = await submitOffer(provider.id, proposal((await makeRequest()).id));
    await assert.rejects(rejectOffer(offer.id, other.id), /Not authorized/);
    await prisma.serviceRequest.update({ where: { id: offer.requestId }, data: { status: 'CLOSED' } });
    await assert.rejects(rejectOffer(offer.id, seeker.id), /open, pending unpaid/);
  });
  await t.test('cash selection rejects siblings with exactly one separate losing notification', async () => {
    const request = await makeRequest();
    const winner = await submitOffer(provider.id, proposal(request.id));
    const loser = await submitOffer(other.id, proposal(request.id));
    const booking = await createDirectFromOfferService(winner.id, seeker.id);
    assert.equal(booking.paymentStatus, 'UNPAID');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: loser.id } })).status, 'REJECTED');
    assert.equal(await prisma.notification.count({ where: { id: `offer-not-selected:${loser.id}` } }), 1);
    assert.equal(await prisma.notification.count({ where: { id: `offer-declined:${loser.id}` } }), 0);
    assert.equal((await mine(other.id)).find((item: any) => item.id === loser.id).decisionReason, 'NOT_SELECTED');
    await assert.rejects(rejectOffer(loser.id, seeker.id));
    await assert.rejects(createDirectFromOfferService(winner.id, seeker.id));
    assert.equal(await prisma.notification.count({ where: { id: `offer-not-selected:${loser.id}` } }), 1);
  });

  const previous = { fetch: globalThis.fetch, publicKey: env.PAYMONGO_PUBLIC_KEY, secret: env.PAYMONGO_SECRET_KEY, webhook: env.PAYMONGO_WEBHOOK_SECRET };
  t.after(() => { globalThis.fetch = previous.fetch; env.PAYMONGO_PUBLIC_KEY = previous.publicKey; env.PAYMONGO_SECRET_KEY = previous.secret; env.PAYMONGO_WEBHOOK_SECRET = previous.webhook; });
  env.PAYMONGO_PUBLIC_KEY = 'pk_test_offer_lifecycle'; env.PAYMONGO_SECRET_KEY = 'sk_test_offer_lifecycle'; env.PAYMONGO_WEBHOOK_SECRET = 'whsk_test_offer_lifecycle';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith('/payment_intents')) return new Response(JSON.stringify({ data: { id: `pi_${randomUUID()}`, attributes: { client_key: 'test-only', status: 'awaiting_payment_method' } } }));
    if (url.endsWith('/payment_methods')) return new Response(JSON.stringify({ data: { id: 'pm_test' } }));
    if (url.endsWith('/attach')) return new Response(JSON.stringify({ data: { attributes: { status: 'awaiting_next_action', next_action: { type: 'redirect', redirect: { url: 'https://checkout.example.test' } } } } }));
    throw new Error(`Unexpected payment stub route: ${new URL(url).pathname}`);
  };
  const startCheckout = async () => {
    const request = await makeRequest();
    const winner = await submitOffer(provider.id, proposal(request.id));
    const sibling = await submitOffer(other.id, proposal(request.id));
    const attempt = await initiateOnlinePayment({ seekerId: seeker.id, offerId: winner.id, paymentMethod: 'gcash' });
    return { request, winner, sibling, attempt };
  };
  const losingCount = (id: string) => prisma.notification.count({ where: { id: { in: [`offer-not-selected:${id}`, `offer-declined:${id}`] } } });
  await t.test('GCash initiation preserves siblings and prevents paid-hold decisions', async () => {
    const { request, winner, sibling } = await startCheckout();
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'PAYMENT_PENDING');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: winner.id } })).status, 'PENDING_PAYMENT');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: sibling.id } })).status, 'PENDING');
    assert.equal(await losingCount(sibling.id), 0);
    await assert.rejects(rejectOffer(winner.id, provider.id));
    await assert.rejects(rejectOffer(sibling.id, seeker.id));
  });
  await t.test('authoritative GCash success alone finalizes siblings, with idempotent replay', async () => {
    const { winner, sibling, attempt } = await startCheckout();
    const input = { paymentIntentId: attempt.providerIntentId!, paymentId: `pay_${randomUUID()}`, amount: 150, currency: 'PHP', metadata: {
      servicehub_attempt_id: attempt.id, servicehub_seeker_id: seeker.id, servicehub_service_id: '', servicehub_offer_id: winner.id, servicehub_expected_amount: '150.00', servicehub_payment_method: 'gcash',
    } };
    assert.equal((await finalizeSuccessfulPayment(input)).created, true);
    assert.equal((await finalizeSuccessfulPayment(input)).created, false);
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: winner.id } })).status, 'ACCEPTED');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: sibling.id } })).status, 'REJECTED');
    assert.equal(await losingCount(sibling.id), 1);
    assert.equal(await prisma.notification.count({ where: { id: `offer-declined:${sibling.id}` } }), 0);
  });
  await t.test('failed GCash reopens offer and request with no losing notifications', async () => {
    const { request, winner, sibling, attempt } = await startCheckout();
    await markPaymentAttemptFailed(attempt.providerIntentId!, 'payment.failed');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: winner.id } })).status, 'PENDING');
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'OPEN');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: sibling.id } })).status, 'PENDING');
    assert.equal(await losingCount(sibling.id), 0);
  });
  await t.test('expired GCash reopens offer and request with no losing notifications', async () => {
    const { request, winner, sibling, attempt } = await startCheckout();
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expireStalePaymentAttempts();
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status, 'EXPIRED');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: winner.id } })).status, 'PENDING');
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'OPEN');
    assert.equal(await losingCount(sibling.id), 0);
  });
  await t.test('offer validation explains the invalid field using Zod 4 issues', async () => {
    const result = await capture(createOffer, provider.id, { body: { ...proposal((await makeRequest()).id), estimatedDuration: 3 } });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'OFFER_VALIDATION_FAILED');
    assert.match(result.body.error, /Expected duration/);
    assert.ok(result.body.errors.length > 0);
  });
  await t.test('new public requests do not inherit targeting or require provider listings', async () => {
    const request = await createRequest(seeker.id, { categoryId: category.id, title: 'REPAIR A WOODEN CABINET', description: 'The wooden cabinet hinge needs repair by a carpenter.', budgetMin: 150, budgetMax: 300, urgency: 'Needs Tomorrow', paymentMethods: { cash: true, gcash: true } });
    assert.equal(request.targetProviderId, null);
    assert.equal(request.targetServiceId, null);
    assert.equal((await submitOffer(provider.id, proposal(request.id))).status, 'PENDING');
  });
});
