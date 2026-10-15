import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import app from '../app';
import { createService, updateService, browseServices } from '../services/services.service';
import { CreateServiceSchema } from '../schema/services.schema';
import { createListingInquiry, declineListingInquiry } from '../services/listing-inquiries.service';
import { submitOffer, listReceivedOffers, rejectOffer } from '../services/offers.service';
import { createDirectRequest, createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { listRequests, updateRequest } from '../services/requests.service';
import { nearbyRequests } from '../services/nearby.service';
import { initiateOnlinePayment, finalizeSuccessfulPayment } from '../services/payment-attempt.service';

assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
assert.equal(env.NODE_ENV, 'test');
after(() => prisma.$disconnect());

test('private service requests reuse offers and create a booking only after price approval', async t => {
  const tag = randomUUID();
  const user = (name: string) => prisma.user.create({ data: { gcashNumber: '09123456789', name, email: `${name}-${tag}@example.test`, passwordHash: 'unused', phone: '', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED' } });
  const [provider, cashSeeker, onlineSeeker, otherProvider, declinedSeeker, publicSeeker, wrongPhotoSeeker] = await Promise.all(['provider','cash','online','other','declined','public','photo'].map(user));
  const category = await prisma.category.create({ data: { name: `Computer repairs ${tag}` } });
  const service = await createService(provider.id, CreateServiceSchema.parse({ categoryId: category.id, title: 'LAPTOP REPAIR SERVICE', description: 'I diagnose and repair laptop hardware problems. I propose a final price after reviewing the requested work.', priceType: 'BY_AGREEMENT', estimatedDurationMins: 60, serviceLocationMode: 'BOTH', serviceLocation: { latitude: 10.26, longitude: 123.95, label: 'Cordova' }, venueAddress: 'PRIVATE WORKSHOP', coverageRadiusKm: 5, paymentMethods: { cash: true, gcash: true } }));
  const job = { latitude: 10.261, longitude: 123.951, label: 'Day-as, Cordova', address: 'PRIVATE SEEKER ENTRANCE' };
  const photo = await prisma.listingPhoto.create({ data: { ownerId: cashSeeker.id, publicId: `servicehub/listing-photos/${tag}`, url: 'https://res.cloudinary.com/test/image/upload/sample.jpg', width: 640, height: 480 } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const apiBase = `http://127.0.0.1:${address.port}/api`;
  const token = async (account: typeof provider) => {
    const session = await prisma.refreshToken.create({ data: { userId: account.id, token: randomUUID(), expiresAt: new Date(Date.now() + 300_000) } });
    return jwt.sign({ sub: account.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
  };
  const cashToken = await token(cashSeeker), providerToken = await token(provider), otherToken = await token(otherProvider);
  const realFetch = globalThis.fetch;
  const calls: Array<{ amount: number; metadata: Record<string,string> }> = [];
  env.PAYMONGO_PUBLIC_KEY = 'pk_test_agreement'; env.PAYMONGO_SECRET_KEY = 'sk_test_agreement'; env.PAYMONGO_WEBHOOK_SECRET = 'test_agreement_webhook';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(apiBase)) return realFetch(input, init);
    assert.ok(url.startsWith('https://api.paymongo.com/v1/'), 'Unexpected external request in isolated test');
    const path = new URL(url).pathname;
    if (path.endsWith('/payment_intents') && init?.method === 'POST') {
      const attributes = JSON.parse(String(init.body)).data.attributes; calls.push(attributes);
      return Response.json({ data: { id: `pi_agreement_${calls.length}`, attributes: { client_key: 'test-client', status: 'awaiting_payment_method' } } });
    }
    if (path.endsWith('/payment_methods')) return Response.json({ data: { id: 'pm_agreement' } });
    if (path.endsWith('/attach')) return Response.json({ data: { attributes: { status: 'awaiting_next_action', next_action: { type: 'redirect', redirect: { url: 'https://test-gcash.example/authorize' } } } } });
    throw new Error('Unexpected gateway operation');
  }) as typeof fetch;
  let inquiry!: Awaited<ReturnType<typeof createListingInquiry>>;
  let onlineInquiry!: Awaited<ReturnType<typeof createListingInquiry>>;
  try {
    await t.test('publishes without a price and rejects attempts to bypass the request/price stage', async () => {
      assert.equal(service.price, null); assert.equal(service.priceType, 'BY_AGREEMENT');
      assert.equal((await browseServices({ ids: [service.id] })).length, 1);
      await assert.rejects(createDirectRequest({ seekerId: cashSeeker.id, providerId: provider.id, serviceId: service.id, message: 'Repair the laptop', serviceLocationMode: 'PROVIDER_VISITS', jobLocation: job }), /price confirmation/);
      await assert.rejects(initiateOnlinePayment({ seekerId: onlineSeeker.id, serviceId: service.id, paymentMethod: 'gcash', serviceLocationMode: 'SEEKER_VISITS' }), /price confirmation/);
      assert.equal(calls.length, 0);
      assert.equal(await prisma.booking.count({ where: { serviceId: service.id } }), 0);
    });
    await t.test('requests are participant-only, include owned photos, and create no booking, payment or queue place', async () => {
      const response = await fetch(`${apiBase}/requests/listing-inquiry`, { method: 'POST', headers: { Authorization: `Bearer ${cashToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceId: service.id, serviceLocationMode: 'PROVIDER_VISITS', jobLocation: job, message: 'The laptop does not turn on. Please check and repair it.', photoIds: [photo.id] }) });
      assert.equal(response.status, 201); inquiry = (await response.json() as any).data;
      assert.equal(inquiry.targetProviderId, provider.id); assert.equal(inquiry.targetServiceId, service.id); assert.equal(inquiry.photos[0].id, photo.id);
      assert.ok(!JSON.stringify(inquiry).includes('PRIVATE SEEKER ENTRANCE'));
      assert.equal((await listRequests(undefined, provider.id, undefined, [inquiry.id])).length, 1);
      assert.equal((await listRequests(undefined, otherProvider.id, undefined, [inquiry.id])).length, 0);
      const privateRead = await fetch(`${apiBase}/requests/${inquiry.id}`, { headers: { Authorization: `Bearer ${otherToken}` } }); assert.equal(privateRead.status, 404);
      const map = await nearbyRequests({ latitude: job.latitude, longitude: job.longitude, radiusKm: 5, page: 1, limit: 12, filter: 'all' }, provider.id);
      assert.ok(!JSON.stringify(map).includes(inquiry.id));
      assert.equal(await prisma.booking.count({ where: { serviceId: service.id } }), 0);
      assert.equal(await prisma.paymentAttempt.count({ where: { serviceId: service.id } }), 0);
      assert.equal(await prisma.queue.count({ where: { providerId: provider.id } }), 0);
      await assert.rejects(createListingInquiry(provider.id, { serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', message: 'I will request my own laptop repair.' }), /own|self|same account/);
      await assert.rejects(createListingInquiry(wrongPhotoSeeker.id, { serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', message: 'Please repair my laptop at your workshop.', photoIds: [photo.id] }), /belongs to another/);
    });
    await t.test('concurrent duplicate requests and replies from another provider are blocked', async () => {
      const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => createListingInquiry(onlineSeeker.id, { serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', message: 'My laptop screen is damaged. I can bring it to your workshop.' })));
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      onlineInquiry = (attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<typeof onlineInquiry>).value;
      await assert.rejects(submitOffer(otherProvider.id, { requestId: inquiry.id, serviceId: service.id, offeredPrice: 500, estimatedDuration: 30, message: 'I will check and repair the laptop.' }), /reserved/);
      await assert.rejects(submitOffer(provider.id, { requestId: inquiry.id, serviceId: service.id, offeredPrice: 500, estimatedDuration: 30 }), /included in your price/);
    });
    await t.test('provider decline is idempotent and allows a fresh request without creating a booking', async () => {
      const request = await createListingInquiry(declinedSeeker.id, { serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', message: 'Can you repair the broken charging port?' });
      await assert.rejects(declineListingInquiry(otherProvider.id, request.id), /not available/);
      await declineListingInquiry(provider.id, request.id); await declineListingInquiry(provider.id, request.id);
      assert.equal(await prisma.notification.count({ where: { id: `inquiry-declined:${request.id}` } }), 1);
      const next = await createListingInquiry(declinedSeeker.id, { serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', message: 'I am requesting charging port repair again.' });
      assert.notEqual(next.id, request.id);
      await declineListingInquiry(provider.id, next.id);
      assert.equal(await prisma.booking.count({ where: { seekerId: declinedSeeker.id } }), 0);
    });
    await t.test('declining or withdrawing an unapproved price closes only its private inquiry and permits a fresh request', async () => {
      const makeRequest = () => createListingInquiry(declinedSeeker.id, { serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', message: 'Please repair the laptop charging port at your workshop.' });
      const proposed = await makeRequest();
      const quote = await submitOffer(provider.id, { requestId: proposed.id, serviceId: service.id, offeredPrice: 900, estimatedDuration: 45, message: 'Charging port repair including parts and labor.', serviceLocationMode: 'SEEKER_VISITS' });
      await rejectOffer(quote.id, declinedSeeker.id); await rejectOffer(quote.id, declinedSeeker.id);
      assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: proposed.id } })).status, 'CANCELED');
      assert.equal(await prisma.notification.count({ where: { id: `offer-declined:${quote.id}` } }), 1);
      const retry = await makeRequest();
      const nextQuote = await submitOffer(provider.id, { requestId: retry.id, serviceId: service.id, offeredPrice: 950, estimatedDuration: 45, message: 'Charging port repair including parts and labor.', serviceLocationMode: 'SEEKER_VISITS' });
      await rejectOffer(nextQuote.id, provider.id); await rejectOffer(nextQuote.id, provider.id);
      assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: retry.id } })).status, 'CANCELED');
      assert.equal(await prisma.notification.count({ where: { id: `price-withdrawn:${nextQuote.id}` } }), 1);
      const fresh = await makeRequest(); assert.notEqual(fresh.id, retry.id); await declineListingInquiry(provider.id, fresh.id);
      assert.equal(await prisma.booking.count({ where: { seekerId: declinedSeeker.id } }), 0);
      assert.equal(await prisma.paymentAttempt.count({ where: { seekerId: declinedSeeker.id } }), 0);
    });
    await t.test('accepting with a price creates only a pending offer; the request and scope stay stable', async () => {
      const offer = await submitOffer(provider.id, { requestId: inquiry.id, serviceId: service.id, offeredPrice: 1250.50, estimatedDuration: 45, message: 'Diagnostics and charging port repair, including labor, parts and travel.', serviceLocationMode: 'PROVIDER_VISITS' });
      assert.equal(offer.status, 'PENDING'); assert.equal(await prisma.booking.count({ where: { offerId: offer.id } }), 0);
      await assert.rejects(updateRequest(inquiry.id, cashSeeker.id, { description: 'Changed work that was not quoted by the provider.' }), /original request details/);
      await assert.rejects(declineListingInquiry(provider.id, inquiry.id), /already sent a price/);
      await assert.rejects(submitOffer(provider.id, { requestId: inquiry.id, serviceId: service.id, offeredPrice: 2500, estimatedDuration: 60, message: 'Different price for the same request and work.' }), /already submitted/);
      const rows = await listReceivedOffers(cashSeeker.id); assert.equal(rows.find(row => row.id === offer.id)?.request.targetServiceId, service.id);
      await assert.rejects(createDirectFromOfferService(offer.id, otherProvider.id), /authorized|not found/i);
      await updateService(service.id, provider.id, { priceType: 'FIXED', price: 5000, transportationFee: 125 });
      const booking = await createDirectFromOfferService(offer.id, cashSeeker.id);
      assert.equal(Number(booking.agreedAmount), 1250.50); assert.equal(booking.status, 'ACCEPTED'); assert.equal(booking.started, false);
      assert.deepEqual(booking.jobLocation, job); assert.equal(booking.transportationFee, null);
      assert.equal(await prisma.queue.count({ where: { bookingId: booking.id } }), 0);
    });
    await t.test('GCash uses the approved offer total, holds payment before booking, and finalizes idempotently', async () => {
      // A new quote requires the source listing to still permit agreement pricing.
      await updateService(service.id, provider.id, { priceType:'BY_AGREEMENT', price:null });
      const offer = await submitOffer(provider.id, { requestId: onlineInquiry.id, serviceId: service.id, offeredPrice: 2200, estimatedDuration: 90, serviceLocationMode: 'SEEKER_VISITS', message: 'Screen replacement with parts and labor included in the final total.' });
      assert.equal(offer.venueLabel, 'Cordova'); assert.ok(!JSON.stringify(offer).includes('PRIVATE WORKSHOP'));
      const attempt = await initiateOnlinePayment({ seekerId: onlineSeeker.id, offerId: offer.id, paymentMethod: 'gcash' });
      assert.equal(Number(attempt.amount), 2200); assert.equal(calls.at(-1)?.amount, 220000);
      assert.equal(await prisma.booking.count({ where: { offerId: offer.id } }), 0);
      assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status, 'PENDING_PAYMENT');
      await assert.rejects(rejectOffer(offer.id, provider.id), /pending unpaid/);
      const proof = { paymentIntentId: attempt.providerIntentId!, paymentId: `pay_${tag}`, amount: 2200, currency: 'PHP', metadata: calls.at(-1)!.metadata };
      await assert.rejects(finalizeSuccessfulPayment({ ...proof, amount: 2300 }), /amount|match/i);
      const first = await finalizeSuccessfulPayment(proof), second = await finalizeSuccessfulPayment(proof);
      assert.equal(first.created, true); assert.equal(second.created, false); assert.ok(first.booking);
      assert.equal(Number(first.booking.agreedAmount), 2200); assert.equal(first.booking.started, false);
      assert.deepEqual(first.booking.jobLocation, { latitude: 10.26, longitude: 123.95, label: 'Cordova', address: 'PRIVATE WORKSHOP' });
      assert.equal(await prisma.booking.count({ where: { offerId: offer.id } }), 1);
      assert.equal(await prisma.queue.count({ where: { bookingId: first.booking.id } }), 1);
    });
    await t.test('normal public offers keep their existing single selection and cash booking path', async () => {
      const request = await prisma.serviceRequest.create({ data: { seekerId: publicSeeker.id, categoryId: category.id, title: 'Laptop needs repair', description: 'Repair my laptop charging issue.', budgetMin: 500, budgetMax: 3000, urgency: 'This Week', serviceLocationMode: 'PROVIDER_VISITS', latitude: job.latitude, longitude: job.longitude, locationLabel: job.label, paymentMethods: { cash: true, gcash: true } } });
      const offer = await submitOffer(provider.id, { requestId: request.id, offeredPrice: 900, estimatedDuration: 60, serviceLocationMode: 'PROVIDER_VISITS', message: 'Repair the laptop power connection.' });
      const declinedOffer = await submitOffer(otherProvider.id, { requestId: request.id, offeredPrice: 800, estimatedDuration: 60, serviceLocationMode: 'PROVIDER_VISITS', message: 'I can repair the laptop power connection.' });
      await rejectOffer(declinedOffer.id, publicSeeker.id);
      assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'OPEN');
      const booking = await createDirectFromOfferService(offer.id, publicSeeker.id);
      assert.equal(Number(booking.agreedAmount), 900); assert.equal(booking.status, 'ACCEPTED'); assert.equal(booking.started, false);
    });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
