import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { OfferStatus, RequestStatus, PaymentAttemptStatus } from '@prisma/client';
import app from '../app';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { initSocket } from '../lib/socket';
import { cancelRequest, getMyRequests } from '../services/requests.service';
import { createDirectFromOfferService } from '../services/bookings/direct-bookings.service';

test('request deletion is success-only and blocked deletes are true no-ops', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') ?? '', /^audit_20260924_[a-f0-9]{32}$/, 'Use the disposable audit schema, never application data.');
  const suffix = randomUUID();
  const users = await Promise.all(['seeker', 'provider', 'outsider'].map(name => prisma.user.create({ data: {
    name, email: `${name}-${suffix}@example.test`, passwordHash: 'test-only', phone: 'test-only', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED',
  } })));
  const [seeker, provider, outsider] = users;
  const category = await prisma.category.create({ data: { name: `Plumbing ${suffix}` } });
  const headers = await Promise.all(users.map(async user => {
    const session = await prisma.refreshToken.create({ data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
    return { Authorization: `Bearer ${jwt.sign({ sub: user.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' })}` };
  }));
  const server = app.listen(0, '127.0.0.1');
  const io = initSocket(server);
  const events: string[] = [];
  t.mock.method(io, 'emit', ((event: string) => { events.push(event); return true; }) as typeof io.emit);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => { io.close(); server.closeAllConnections(); await prisma.$disconnect(); });
  const request = (status: RequestStatus = 'OPEN') => prisma.serviceRequest.create({ data: {
    seekerId: seeker.id, categoryId: category.id, title: `FIX LEAKING PIPE ${randomUUID()}`, description: 'Repair a leaking kitchen water pipe.',
    urgency: 'Flexible Schedule', budgetMin: 500, budgetMax: 500, status, paymentMethods: { cash: true, gcash: true },
  } });
  const offer = (requestId: string, status: OfferStatus = 'PENDING') => prisma.offer.create({ data: {
    requestId, providerId: provider.id, status, offeredPrice: 500, estimatedDuration: 60, message: 'I can repair this pipe.',
  } });
  const snapshot = async (id: string) => {
    const offers = await prisma.offer.findMany({ where: { requestId: id }, orderBy: { id: 'asc' } });
    const offerIds = offers.map(row => row.id);
    const bookings = await prisma.booking.findMany({ where: { offerId: { in: offerIds } }, orderBy: { id: 'asc' } });
    const bookingIds = bookings.map(row => row.id);
    return {
      request: await prisma.serviceRequest.findUniqueOrThrow({ where: { id } }), offers, bookings,
      payments: await prisma.paymentAttempt.findMany({ where: { offerId: { in: offerIds } }, orderBy: { id: 'asc' } }),
      queues: await prisma.queue.findMany({ where: { bookingId: { in: bookingIds } }, orderBy: { id: 'asc' } }),
      messages: await prisma.message.findMany({ where: { bookingId: { in: bookingIds } }, orderBy: { id: 'asc' } }),
      notifications: await prisma.notification.findMany({ where: { userId: { in: [seeker.id, provider.id] } }, orderBy: { id: 'asc' } }),
    };
  };
  const rejectUnchanged = async (id: string) => {
    const before = await snapshot(id);
    events.length = 0;
    const response = await fetch(`${base}/requests/${id}`, { method: 'DELETE', headers: headers[0] });
    assert.equal(response.status, 409);
    const body = await response.json() as { success: boolean; error: string; code: string };
    assert.equal(body.code, 'REQUEST_DELETE_BLOCKED');
    assert.match(body.error, /can’t be deleted|Reopen/);
    assert.doesNotMatch(body.error, /unmatched/);
    assert.deepEqual(await snapshot(id), before, 'No request, offer, booking, queue, payment, chat or notification may change.');
    assert.deepEqual(events, [], 'No request/booking invalidation event on rejection.');
    const owner = (await getMyRequests(seeker.id)).find(row => row.id === id);
    assert.ok(owner);
    assert.equal(owner.canDelete, false);
    assert.equal(owner.deleteBlockedReason, body.error, 'List and mutation must use the same rule.');
    return body;
  };

  await t.test('unmatched open request deletes successfully and stays absent after fresh owner/public reads', async () => {
    const row = await request();
    const pending = await offer(row.id);
    assert.equal((await getMyRequests(seeker.id)).find(item => item.id === row.id)?.canDelete, true);
    const response = await fetch(`${base}/requests/${row.id}`, { method: 'DELETE', headers: headers[0] });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { success: boolean }).success, true);
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: row.id } })).status, 'CANCELED');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: pending.id } })).status, 'REJECTED');
    assert.ok(!(await getMyRequests(seeker.id)).some(item => item.id === row.id));
    const board = await (await fetch(`${base}/requests`, { headers: headers[1] })).json() as { data: { id: string }[] };
    assert.ok(!board.data.some(item => item.id === row.id));
  });
  await t.test('accepted offer with a stale OPEN request and no booking is protected', async () => {
    const row = await request(); await offer(row.id, 'ACCEPTED');
    assert.match((await rejectUnchanged(row.id)).error, /offer has already been accepted/);
  });
  await t.test('active booking remains visible to seeker and provider after rejection and reload', async () => {
    const row = await request('IN_PROGRESS');
    const accepted = await offer(row.id, 'ACCEPTED');
    const booking = await prisma.booking.create({ data: {
      offerId: accepted.id, seekerId: seeker.id, providerId: provider.id, status: 'WAITING', agreedAmount: 500,
      paymentMethod: 'GCash', paymentStatus: 'PAID_HELD', originType: 'OFFER',
    } });
    await prisma.queue.create({ data: { bookingId: booking.id, offerId: accepted.id, seekerId: seeker.id, providerId: provider.id,
      paymentId: randomUUID(), position: 1, estimatedWait: 60, status: 'WAITING', paymentStatus: 'PAID_HELD' } });
    await prisma.message.create({ data: { bookingId: booking.id, senderId: seeker.id, receiverId: provider.id, content: 'Please repair the pipe.' } });
    await prisma.paymentAttempt.create({ data: { offerId: accepted.id, seekerId: seeker.id, providerId: provider.id,
      idempotencyKey: randomUUID(), amount: 500, paymentMethod: 'GCash', status: 'SUCCEEDED', expiresAt: new Date(Date.now() + 3600000) } });
    const views = async () => Promise.all(headers.slice(0, 2).map(async auth => {
      const res = await fetch(`${base}/bookings/my-engagements`, { headers: auth });
      assert.equal(res.status, 200);
      const body = await res.json() as { data: { bookings: { id: string }[] } };
      const active = body.data.bookings.find(item => item.id === booking.id);
      assert.ok(active, 'Both participants must still see the same booking.');
      return active;
    }));
    const before = await views();
    await rejectUnchanged(row.id);
    assert.deepEqual(await views(), before);
    assert.deepEqual(await views(), before, 'An additional reload cannot restore/change hidden data.');
  });
  for (const status of ['PENDING', 'SUCCEEDED', 'REFUND_REQUIRED'] as PaymentAttemptStatus[]) {
    await t.test(`${status} payment blocks deletion even if request/offer still look open`, async () => {
      const row = await request(); const pending = await offer(row.id);
      await prisma.paymentAttempt.create({ data: { offerId: pending.id, seekerId: seeker.id, providerId: provider.id,
        idempotencyKey: randomUUID(), amount: 500, paymentMethod: 'GCash', status, expiresAt: new Date(Date.now() + 3600000) } });
      assert.match((await rejectUnchanged(row.id)).error, /payment or refund/);
    });
  }
  await t.test('pending-payment offer and completed booking history are independently protected', async () => {
    const paying = await request(); await offer(paying.id, 'PENDING_PAYMENT'); await rejectUnchanged(paying.id);
    const completed = await request(); const selected = await offer(completed.id, 'REJECTED');
    await prisma.booking.create({ data: { offerId: selected.id, seekerId: seeker.id, providerId: provider.id,
      status: 'COMPLETED', paymentMethod: 'On-site Cash', paymentStatus: 'CASH_CONFIRMED', agreedAmount: 500 } });
    assert.match((await rejectUnchanged(completed.id)).error, /completed booking/);
  });
  await t.test('another account cannot delete the request', async () => {
    const row = await request(); const before = await snapshot(row.id);
    const res = await fetch(`${base}/requests/${row.id}`, { method: 'DELETE', headers: headers[2] });
    assert.equal(res.status, 404); assert.deepEqual(await snapshot(row.id), before);
  });
  await t.test('accept/delete race is serialized: exactly one succeeds without corrupting the booking', async () => {
    const row = await request(); const pending = await offer(row.id);
    const results = await Promise.allSettled([cancelRequest(row.id, seeker.id), createDirectFromOfferService(pending.id, seeker.id)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const state = await snapshot(row.id);
    if (state.request.status === 'CANCELED') {
      assert.equal(state.offers[0].status, 'REJECTED'); assert.equal(state.bookings.length, 0);
    } else {
      assert.equal(state.request.status, 'IN_PROGRESS'); assert.equal(state.offers[0].status, 'ACCEPTED');
      assert.equal(state.bookings.length, 1); assert.equal(state.bookings[0].status, 'ACCEPTED');
    }
  });
});
