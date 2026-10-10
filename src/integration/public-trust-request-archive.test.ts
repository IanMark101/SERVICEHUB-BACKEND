import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import app from '../app';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { createRequest } from '../services/requests.service';

test('public trust and completed request visibility preserve account and booking history', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') ?? '', /^servicehub_migration_test_[a-f0-9]{32}$/, 'Use the disposable migration runner, never application data.');
  assert.equal(process.env.SERVICEHUB_TRUST_REQUEST_ONLY, '1');
  const suffix = randomUUID();
  const users = await Promise.all(['seeker', 'provider', 'outsider', 'admin'].map(name => prisma.user.create({ data: {
    name, email: `${name}-${suffix}@example.test`, passwordHash: 'test-only', phone: 'test-only', location: 'Cordova',
    emailVerified: true, verificationStatus: 'APPROVED', role: name === 'admin' ? 'admin' : 'user',
  } })));
  const [seeker, provider, outsider, admin] = users;
  const tokens = await Promise.all(users.map(async user => {
    const session = await prisma.refreshToken.create({ data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
    return jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });
  const call = (path: string, userIndex = 0, method = 'GET', body?: object) => fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tokens[userIndex]}`, 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  const category = await prisma.category.create({ data: { name: `Plumbing ${suffix}` } });
  const request = await prisma.serviceRequest.create({ data: {
    seekerId: seeker.id, categoryId: category.id, title: 'FIX LEAKING PIPE', description: 'Repair a leaking kitchen water pipe.',
    budgetMin: 500, budgetMax: 500, urgency: 'Needs Tomorrow', status: 'CLOSED', paymentMethods: { cash: true, gcash: false },
  } });
  const offer = await prisma.offer.create({ data: { requestId: request.id, providerId: provider.id, offeredPrice: 500, estimatedDuration: 60, status: 'ACCEPTED' } });
  const booking = await prisma.booking.create({ data: { offerId: offer.id, seekerId: seeker.id, providerId: provider.id,
    agreedAmount: 500, paymentMethod: 'On-site Cash', paymentStatus: 'CASH_CONFIRMED', status: 'COMPLETED', started: true,
    progressEvents: { create: { kind: 'SEEKER_CONFIRMED', actorRole: 'seeker', eventKey: 'confirmation', occurredAt: new Date() } },
  } });
  const completed = await prisma.completedService.create({ data: { bookingId: booking.id, offerId: offer.id, seekerId: seeker.id, providerId: provider.id, finalPrice: 500, paymentStatus: 'CASH_CONFIRMED' } });
  await prisma.message.create({ data: { bookingId: booking.id, senderId: seeker.id, receiverId: provider.id, content: 'Thank you.' } });
  await prisma.review.create({ data: { completedServiceId: completed.id, authorId: provider.id, targetId: seeker.id, rating: 5, text: 'Reliable client.', editableUntil: new Date(Date.now() + 86400000) } });
  await prisma.paymentAttempt.create({ data: { idempotencyKey: suffix, seekerId: seeker.id, providerId: provider.id, offerId: offer.id,
    amount: 500, paymentMethod: 'GCash', status: 'REFUNDED', expiresAt: new Date() } });
  const snapshot = async () => Promise.all([
    prisma.booking.findUnique({ where: { id: booking.id }, include: { messages: true, progressEvents: true, completedService: { include: { reviews: true } } } }),
    prisma.offer.findUnique({ where: { id: offer.id } }), prisma.paymentAttempt.findMany({ where: { offerId: offer.id } }),
  ]);
  const before = await snapshot();

  await t.test('all signed-in users can see public changes, while owners/admins keep raw history', async () => {
    await prisma.trustScoreEvent.create({ data: { userId: seeker.id, actorAdminId: admin.id, delta: -5, requestedDelta: -5,
      scoreBefore: 55, scoreAfter: 50, reason: 'Private administrator evidence', eventKey: `manual-trust:${admin.id}:${suffix}` } });
    for (const index of [1, 2]) {
      const response = await call(`/auth/trust-history/${seeker.id}`, index);
      assert.equal(response.status, 200);
      const events = (await response.json()).data;
      assert.equal(events.length, 1);
      assert.deepEqual(Object.keys(events[0]).sort(), ['id', 'delta', 'reason', 'scoreBefore', 'scoreAfter', 'createdAt'].sort());
      assert.equal(events[0].reason, 'Trust score adjusted by administrator');
      assert.equal(events[0].delta, -5);
    }
    for (const index of [0, 3]) {
      const response = await call(`/auth/trust-history/${seeker.id}`, index);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data[0].reason, 'Private administrator evidence');
    }
    assert.equal((await call('/auth/trust-history/missing-user', 2)).status, 404);
  });

  await t.test('only the owner can copy or archive completed requests; open/active requests are protected', async () => {
    for (const index of [1, 2]) {
      assert.equal((await call(`/requests/${request.id}/repost-template`, index)).status, 404);
      assert.equal((await call(`/requests/${request.id}/archive`, index, 'POST')).status, 404);
    }
    const open = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id,
      title: 'FIX ANOTHER PIPE', description: request.description, budgetMin: 500, budgetMax: 500, urgency: 'Flexible Schedule',
      paymentMethods: { cash: true, gcash: false } } });
    assert.equal((await call(`/requests/${open.id}/archive`, 0, 'POST')).status, 409);
    assert.equal((await call(`/requests/${open.id}/repost-template`)).status, 409);
    assert.ok((await (await call('/requests/mine')).json()).data.some((row: { id: string }) => row.id === open.id));
    const active = await prisma.offer.create({ data: { requestId: open.id, providerId: provider.id, offeredPrice: 500, estimatedDuration: 60, status: 'PENDING' } });
    assert.ok((await (await call('/requests/mine')).json()).data.some((row: { id: string }) => row.id === open.id), 'Receiving an offer alone must not hide the listing.');
    const accepted = await call('/bookings/direct-from-offer', 0, 'POST', { offerId: active.id });
    assert.equal(accepted.status, 201, await accepted.text());
    const activeBooking = await prisma.booking.findUniqueOrThrow({ where: { offerId: active.id } });
    assert.equal((await call(`/requests/${open.id}/archive`, 0, 'POST')).status, 409);
    assert.equal((await call(`/requests/${open.id}/repost-template`)).status, 409);
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: activeBooking.id } })).status, 'ACCEPTED');
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: open.id } })).archivedAt, null);
    assert.ok(!(await (await call('/requests/mine')).json()).data.some((row: { id: string }) => row.id === open.id));
    for (const index of [0, 1]) {
      const activity = await call('/bookings/my-engagements', index);
      assert.equal(activity.status, 200);
      const data = (await activity.json()).data;
      assert.ok(data.bookings.some((row: { id: string }) => row.id === activeBooking.id));
    }
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: open.id } })).status, 'IN_PROGRESS');
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('booked requests disappear automatically while paused and pending-payment requests remain', async () => {
    const paused = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id,
      title: 'PAUSED PIPE REQUEST', description: request.description, budgetMin: 500, budgetMax: 500,
      urgency: 'Flexible Schedule', status: 'CLOSED' } });
    const pending = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id,
      title: 'PIPE PAYMENT PENDING', description: request.description, budgetMin: 500, budgetMax: 500,
      urgency: 'This Week', status: 'PAYMENT_PENDING' } });
    await prisma.offer.create({ data: { requestId: pending.id, providerId: provider.id,
      offeredPrice: 500, estimatedDuration: 60, status: 'PENDING_PAYMENT' } });
    const response = await call('/requests/mine');
    assert.equal(response.status, 200);
    const ids = (await response.json()).data.map((row: { id: string }) => row.id);
    assert.ok(!ids.includes(request.id));
    assert.ok(ids.includes(paused.id));
    assert.ok(ids.includes(pending.id));
    assert.deepEqual(await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } }), request);
    assert.deepEqual(await snapshot(), before);
    for (const index of [0, 1]) {
      const activity = await call('/bookings/my-engagements', index);
      assert.equal(activity.status, 200);
      const data = (await activity.json()).data;
      assert.ok(data.completedServices.some((row: { id: string }) => row.id === completed.id));
      const original = data.bookings.find((row: { id: string }) => row.id === booking.id);
      assert.ok(original);
      assert.equal(original.offer.requestId, request.id);
      assert.equal(original.offer.request.targetServiceId, null);
    }
    assert.equal((await call(`/requests/${request.id}/repost-template`)).status, 200);
  });

  await t.test('archive persists, is idempotent, and leaves both participants’ completed Activity intact', async () => {
    assert.equal((await call(`/requests/${request.id}/archive`, 0, 'POST')).status, 200);
    assert.equal((await call(`/requests/${request.id}/archive`, 0, 'POST')).status, 200);
    const stored = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.ok(stored.archivedAt);
    assert.equal(stored.status, request.status);
    const ownerList = await call('/requests/mine');
    assert.equal(ownerList.status, 200);
    assert.ok(!(await ownerList.json()).data.some((row: { id: string }) => row.id === request.id));
    for (const index of [0, 1]) {
      const response = await call('/bookings/my-engagements', index);
      assert.equal(response.status, 200);
      const data = (await response.json()).data;
      assert.ok(data.bookings.some((row: { id: string }) => row.id === booking.id));
      assert.ok(data.completedServices.some((row: { id: string }) => row.id === completed.id));
      const original = data.bookings.find((row: { id: string }) => row.id === booking.id);
      assert.equal(original.offer.requestId, request.id);
      assert.equal(original.offer.request.targetServiceId, null);
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal((await call(`/requests/${request.id}`, 0, 'PATCH', { status: 'OPEN' })).status, 409);
  });

  await t.test('repost copies permitted details but creates a fresh request through normal posting validation', async () => {
    const response = await call(`/requests/${request.id}/repost-template`);
    assert.equal(response.status, 200);
    const template = (await response.json()).data;
    assert.equal(template.title, request.title);
    assert.equal(template.budget, 500);
    assert.deepEqual(template.paymentMethods, { cash: true, gcash: false });
    assert.ok(!('urgency' in template));
    const body = { categoryId: template.categoryId, title: template.title, description: template.description, budgetMin: template.budget, budgetMax: template.budget, paymentMethods: template.paymentMethods, jobLocation: { latitude:10.3, longitude:123.9, label:"Lapu-Lapu City, Cebu" } };
    assert.equal((await call('/requests', 0, 'POST', body)).status, 400);
    const { jobLocation: _jobLocation, ...withoutLocation } = body;
    assert.equal((await call('/requests', 0, 'POST', { ...withoutLocation, urgency: 'This Week' })).status, 400);
    const posted = await call('/requests', 0, 'POST', { ...body, urgency: 'This Week' });
    assert.equal(posted.status, 201);
    const fresh = (await posted.json()).data;
    assert.notEqual(fresh.id, request.id);
    assert.equal(fresh.status, 'OPEN');
    assert.equal(fresh.archivedAt, null);
    assert.equal(await prisma.offer.count({ where: { requestId: fresh.id } }), 0);
    assert.equal((await call('/requests', 0, 'POST', { ...body, urgency: 'This Week' })).status, 409);
    assert.deepEqual(await snapshot(), before);
    await prisma.category.update({ where: { id: category.id }, data: { isActive: false } });
    assert.equal((await (await call(`/requests/${request.id}/repost-template`)).json()).data.categoryId, '');
    await prisma.category.update({ where: { id: category.id }, data: { isActive: true } });
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { paymentMethods: Prisma.DbNull } });
    assert.equal((await (await call(`/requests/${request.id}/repost-template`)).json()).data.paymentMethods, null);
  });

  await t.test('legacy completed OPEN records do not block creating the next request', async () => {
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { archivedAt: null, status: 'OPEN', title: 'FIX LEGACY PIPE' } });
    const fresh = await createRequest(seeker.id, { categoryId: category.id, title: 'FIX LEGACY PIPE', description: request.description,
      budgetMin: 500, budgetMax: 500, urgency: 'This Week', paymentMethods: { cash: true, gcash: false } });
    assert.notEqual(fresh.id, request.id);
    assert.equal(fresh.status, 'OPEN');
    const managedIds = (await (await call('/requests/mine')).json()).data.map((row: { id: string }) => row.id);
    assert.ok(!managedIds.includes(request.id));
    assert.ok(managedIds.includes(fresh.id));
    assert.deepEqual(await snapshot(), before);
  });
});
