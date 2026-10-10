import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { assertProximityDatabase } from '../../scripts/proximity-db-target';
import { providerStartJob } from '../services/bookings/provider-operations.service';
import { markJobComplete, confirmCompletionService } from '../services/bookings/completion.service';
import { respondToDirectBookingService, createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { initiateOnlinePayment, finalizeSuccessfulPayment, markPaymentAttemptFailed } from '../services/payment-attempt.service';
import { submitOffer } from '../services/offers.service';

test('nearby discovery enters the existing cash, custom offer and verified GCash lifecycles', async t => {
  assertProximityDatabase();
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/, 'This test requires a disposable schema');
  const suffix = randomUUID();
  const category = await prisma.category.create({ data: { name: 'Plumbing' } });
  const makeUser = (name: string, approved = true) => prisma.user.create({ data: { name, email: `${name}-${suffix}@example.test`, phone: 'test-only', passwordHash: 'test-only', emailVerified: true, verificationStatus: approved ? 'APPROVED' : 'UNVERIFIED', location: 'Lapu-Lapu City, Cebu' } });
  const seeker = await makeUser('ProximitySeeker'), provider = await makeUser('ProximityProvider'), sibling = await makeUser('OtherProvider'), ineligible = await makeUser('UnverifiedProvider', false);
  const tokens = new Map<string, string>();
  for (const user of [seeker, provider, sibling, ineligible]) {
    const session = await prisma.refreshToken.create({ data: { userId: user.id, token: createHash('sha256').update(`${user.id}-${suffix}`).digest('hex'), expiresAt: new Date(Date.now() + 900000) } });
    tokens.set(user.id, jwt.sign({ sub: user.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' }));
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const realFetch = globalThis.fetch;
  const call = async (url: string, userId: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const response = await realFetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${tokens.get(userId)}`, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() as any };
  };
  t.after(async () => { globalThis.fetch = realFetch; await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });
  const center = { latitude: 10.3, longitude: 123.9, label: 'Cordova, Cebu' };
  const point = { latitude: 10.305, longitude: 123.9, label: 'Lapu-Lapu City, Cebu' };
  const job = { ...point, address: 'Private test directions' };
  const listingInput = { categoryId: category.id, title: 'Kitchen faucet repair', description: 'Repair leaking kitchen faucets and plumbing pipes with appropriate tools.', price: 200, priceType: 'PER_HOUR', estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: true } };
  const requestInput = { categoryId: category.id, title: 'Repair kitchen faucet leak', description: 'The kitchen faucet and the pipe below the sink are leaking and need repair.', budgetMin: 500, budgetMax: 600, urgency: 'Needs Tomorrow', paymentMethods: { cash: true, gcash: true } };
  assert.equal((await call('/services', provider.id, listingInput)).status, 400, 'new listings need an explicit base');
  assert.equal((await call('/requests', seeker.id, requestInput)).status, 400, 'new requests need an actual job location');
  const created = await call('/services', provider.id, { ...listingInput, serviceLocation: point, coverageRadiusKm: 1, transportationFee: 100 });
  assert.equal(created.status, 201, created.error);
  const service = created.data;
  const requested = await call('/requests', seeker.id, { ...requestInput, jobLocation: job, transportationFee: 150 });
  assert.equal(requested.status, 201, requested.error);
  const request = requested.data;

  await t.test('server filters before pagination, crosses boundaries and omits exact public pins', async () => {
    const fixture = { providerId: provider.id, categoryId: category.id, title: 'Plumbing service', description: 'Test plumbing service.', price: 200, estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: true }, status: 'ACTIVE' as const, isAvailable: true };
    for (let i = 0; i < 7; i++) await prisma.service.create({ data: { ...fixture, titleNormalized: `near-${i}`, latitude: 10.306 + i * .001, longitude: 123.9, locationLabel: 'Lapu-Lapu City' } });
    for (const data of [{ titleNormalized: 'unknown' }, { titleNormalized: 'outside', latitude: 10.5, longitude: 123.9, locationLabel: 'Far city' }, { titleNormalized: 'paused', ...point, label: undefined, locationLabel: point.label, isAvailable: false }, { titleNormalized: 'ineligible', latitude: point.latitude, longitude: point.longitude, locationLabel: point.label, providerId: ineligible.id }]) {
      const { label: _label, ...columns } = data as any;
      await prisma.service.create({ data: { ...fixture, ...columns } });
    }
    const query = '?latitude=10.3&longitude=123.9&radiusKm=2&limit=2';
    const first = await call(`/services/nearby${query}`, seeker.id);
    assert.equal(first.status, 200); assert.equal(first.data.pagination.total, 8); assert.equal(first.data.items.length, 2);
    assert.equal(first.data.items[0].id, service.id);
    for (const item of first.data.items) { assert.equal('latitude' in item, false); assert.equal('longitude' in item, false); assert.ok(item.distanceKm <= 2); }
    const second = await call(`/services/nearby${query}&page=2`, seeker.id);
    assert.equal(second.data.items.length, 2); assert.notEqual(second.data.items[0].id, first.data.items[0].id);
    assert.equal((await call('/services/nearby?latitude=10.3&longitude=123.9&radiusKm=1', seeker.id)).data.pagination.total, 4);
    const discovered = await call('/requests/nearby?latitude=10.3&longitude=123.9&radiusKm=2', provider.id);
    assert.equal(discovered.data.items[0].id, request.id); assert.equal(discovered.data.items[0].transportationFee, '150');
    assert.equal('privateAddress' in discovered.data.items[0], false); assert.equal('latitude' in discovered.data.items[0], false);
    const owned = await call('/requests/mine', seeker.id);
    assert.equal(owned.data.find((item: any) => item.id === request.id).privateAddress, job.address);
    assert.equal((await call('/services/nearby?latitude=91&longitude=123&radiusKm=2', seeker.id)).status, 400);
  });

  await t.test('both marketplaces combine work keywords, category, exact radius and quick filters before pagination', async () => {
    const aircon = await prisma.category.create({ data: { name: 'Aircon Repair' } });
    // Misleading account names must not make plumbing match an aircon search.
    await prisma.user.update({ where: { id: provider.id }, data: { name: 'Aircon Repair Provider' } });
    await prisma.user.update({ where: { id: seeker.id }, data: { name: 'Aircon Repair Seeker' } });
    const fixtures = [];
    for (const km of [2, 7, 15]) {
      const latitude = center.latitude + km / 111.1950802335;
      const listing = await prisma.service.create({ data: {
        providerId: provider.id, categoryId: aircon.id, title: `Aircon repair ${km} km`, titleNormalized: `aircon-${km}`,
        description: 'Air conditioner repair and maintenance.', price: 500, status: 'ACTIVE', isAvailable: true,
        latitude, longitude: center.longitude, locationLabel: 'Test service area', coverageRadiusKm: 1,
      } });
      const jobRequest = await prisma.serviceRequest.create({ data: {
        seekerId: seeker.id, categoryId: aircon.id, title: `Repair my aircon ${km} km`,
        description: 'Air conditioning repair needed.', budgetMin: 500, budgetMax: km === 2 ? 600 : 400,
        urgency: km === 2 ? 'ASAP / Today' : 'Within a Week', status: 'OPEN',
        latitude, longitude: center.longitude, locationLabel: 'Test job area',
      } });
      fixtures.push({ listing, jobRequest });
    }
    const query = '?latitude=10.3&longitude=123.9&radiusKm=10';
    const ids = (response: any) => response.data.items.map((item: any) => item.id);
    const services = await call(`/services/nearby${query}&search=aircon%20repair`, seeker.id);
    assert.deepEqual(ids(services), fixtures.slice(0, 2).map(item => item.listing.id));
    // Coverage uses the actual job pin at booking, never the discovery center.
    assert.equal(services.data.items[1].coverageRadiusKm, 1);
    assert.equal(services.data.items[0].distanceKm, 2);
    const requests = await call(`/requests/nearby${query}&search=repair%20aircon`, provider.id);
    assert.deepEqual(ids(requests), fixtures.slice(0, 2).map(item => item.jobRequest.id));
    for (const [endpoint, owner, field] of [
      ['/services/nearby', seeker.id, 'listing'], ['/requests/nearby', provider.id, 'jobRequest'],
    ] as const) {
      const narrow = await call(`${endpoint}${query.replace('radiusKm=10', 'radiusKm=1')}&search=aircon%20repair`, owner);
      assert.deepEqual(ids(narrow), []);
      const categoryOnly = await call(`${endpoint}${query}&category=aircon%20repair`, owner);
      assert.deepEqual(ids(categoryOnly), fixtures.slice(0, 2).map(item => item[field].id));
      const both = await call(`${endpoint}${query}&category=Aircon%20Repair&search=REPAIR&limit=1&page=2`, owner);
      assert.equal(both.data.pagination.total, 2);
      assert.deepEqual(ids(both), [fixtures[1][field].id]);
      const conflict = await call(`${endpoint}${query}&category=Plumbing&search=aircon%20repair`, owner);
      assert.deepEqual(ids(conflict), []);
      const cleared = await call(`${endpoint}${query}&category=All%20Categories&limit=30`, owner);
      assert.ok(ids(cleared).includes(field === 'listing' ? service.id : request.id));
    }
    const urgent = await call(`/requests/nearby${query}&category=Aircon%20Repair&filter=urgent`, provider.id);
    assert.deepEqual(ids(urgent), [fixtures[0].jobRequest.id]);
    const budget = await call(`/requests/nearby${query}&search=aircon&filter=high-budget`, provider.id);
    assert.deepEqual(ids(budget), [fixtures[0].jobRequest.id]);
    const unrated = await call(`/services/nearby${query}&search=aircon&filter=rated`, seeker.id);
    assert.deepEqual(ids(unrated), []);
    const available = await call(`/services/nearby${query}&search=aircon&filter=available`, seeker.id);
    assert.deepEqual(ids(available), fixtures.slice(0, 2).map(item => item.listing.id));
  });

  await t.test('cash coverage and one-time travel total lead into normal completion', async () => {
    const outside = await call('/bookings/direct', seeker.id, { serviceId: service.id, jobLocation: { ...job, latitude: 10.32 }, quantity: 3 });
    assert.equal(outside.status, 409);
    const result = await call('/bookings/direct', seeker.id, { serviceId: service.id, jobLocation: job, quantity: 3 });
    assert.equal(result.status, 201, result.error);
    const booking = await prisma.booking.findFirstOrThrow({ where: { directRequestId: result.data.id } });
    assert.equal(Number(booking.agreedAmount), 700); assert.equal(Number(booking.transportationFee), 100); assert.deepEqual(booking.jobLocation, job);
    await prisma.user.update({ where: { id: seeker.id }, data: { location: 'A different profile area' } });
    await prisma.service.update({ where: { id: service.id }, data: { latitude: 11, locationLabel: 'Changed operating base' } });
    const accepted = await respondToDirectBookingService(result.data.id, provider.id, true);
    assert.equal(accepted.status, 'ACCEPTED'); assert.deepEqual(accepted.jobLocation, job);
    await providerStartJob(booking.id, provider.id); await markJobComplete(booking.id, provider.id);
    assert.equal((await confirmCompletionService(booking.id, seeker.id)).paymentStatus, 'CASH_CONFIRMED');
    assert.equal(await prisma.queue.count({ where: { bookingId: booking.id } }), 0);
    await prisma.service.update({ where: { id: service.id }, data: { latitude: point.latitude, locationLabel: point.label } });
  });

  await t.test('listing-free proposals retain sibling rejection and use one final travel-inclusive quote', async () => {
    const offer = await submitOffer(provider.id, { requestId: request.id, offeredPrice: 550, estimatedDuration: 60, message: 'I will repair the faucet, including transportation.' });
    const other = await submitOffer(sibling.id, { requestId: request.id, offeredPrice: 500, estimatedDuration: 60, message: 'I can repair this faucet.' });
    const move = await call(`/requests/${request.id}`, seeker.id, { jobLocation: { ...job, latitude: 10.31 } }, 'PATCH');
    assert.equal(move.status, 409, 'an active quote freezes the quoted location');
    const booking = await createDirectFromOfferService(offer.id, seeker.id);
    assert.equal(Number(booking.agreedAmount), 550, 'the optional allowance is not added to a quote'); assert.deepEqual(booking.jobLocation, job);
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: other.id } })).status, 'REJECTED');
    await providerStartJob(booking.id, provider.id); await markJobComplete(booking.id, provider.id); await confirmCompletionService(booking.id, seeker.id);
  });

  await t.test('GCash retry retains the owned job pin and capture uses immutable prepared terms', async () => {
    const keys = [env.PAYMONGO_PUBLIC_KEY, env.PAYMONGO_SECRET_KEY, env.PAYMONGO_WEBHOOK_SECRET];
    env.PAYMONGO_PUBLIC_KEY = 'pk_test_proximity'; env.PAYMONGO_SECRET_KEY = 'sk_test_proximity'; env.PAYMONGO_WEBHOOK_SECRET = 'whsec_test_proximity';
    let serial = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/payment_intents')) return Response.json({ data: { id: `pi_proximity_${suffix}_${++serial}`, attributes: { client_key: 'test_client' } } });
      if (url.endsWith('/payment_methods')) return Response.json({ data: { id: `pm_${suffix}` } });
      if (url.endsWith('/attach')) return Response.json({ data: { attributes: { status: 'awaiting_next_action', next_action: { type: 'redirect', redirect: { url: 'https://test-sources.paymongo.com/sources/proximity' } } } } });
      throw new Error('Unexpected mocked payment request');
    };
    try {
      const first = await initiateOnlinePayment({ seekerId: seeker.id, serviceId: service.id, quantity: 2, jobLocation: job, paymentMethod: 'gcash' });
      assert.equal(await prisma.booking.count({ where: { paymentAttemptId: first.id } }), 0, 'initiation is not a booking');
      await markPaymentAttemptFailed(first.providerIntentId!, 'Test payment failed');
      await assert.rejects(initiateOnlinePayment({ seekerId: sibling.id, serviceId: service.id, retryPaymentIntentId: first.providerIntentId!, quantity: 2, paymentMethod: 'gcash' }), /not found/);
      const retry = await initiateOnlinePayment({ seekerId: seeker.id, serviceId: service.id, retryPaymentIntentId: first.providerIntentId!, quantity: 2, paymentMethod: 'gcash' });
      assert.deepEqual(retry.jobLocation, job); assert.equal(Number(retry.amount), 500);
      await prisma.service.update({ where: { id: service.id }, data: { latitude: 11, transportationFee: 300, estimatedDurationMins: 90 } });
      const payment = { paymentIntentId: retry.providerIntentId!, paymentId: `pay_${suffix}`, amount: 500, currency: 'PHP', metadata: { servicehub_attempt_id: retry.id, servicehub_seeker_id: seeker.id, servicehub_service_id: service.id, servicehub_offer_id: '', servicehub_expected_amount: '500.00', servicehub_payment_method: 'gcash' } };
      const paid = await finalizeSuccessfulPayment(payment);
      assert.ok(paid.booking); assert.deepEqual(paid.booking.jobLocation, job); assert.equal(Number(paid.booking.agreedAmount), 500); assert.equal(paid.booking.estimatedDurationMins, 120);
      await finalizeSuccessfulPayment(payment);
      assert.equal(await prisma.booking.count({ where: { paymentAttemptId: retry.id } }), 1); assert.equal(await prisma.queue.count({ where: { bookingId: paid.booking.id } }), 1);
      await providerStartJob(paid.booking.id, provider.id); await markJobComplete(paid.booking.id, provider.id); await confirmCompletionService(paid.booking.id, seeker.id);
      assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status, 'COMPLETED');
    } finally { globalThis.fetch = realFetch; [env.PAYMONGO_PUBLIC_KEY, env.PAYMONGO_SECRET_KEY, env.PAYMONGO_WEBHOOK_SECRET] = keys; }
  });
});
