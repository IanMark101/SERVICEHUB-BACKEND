import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import adminRoutes from '../routes/admin.routes';

test('admin profiles enforce authorization, redact secrets, paginate histories, and separate appeals', { timeout: 180000 }, async t => {
  const suffix = randomUUID(); const userIds: string[] = []; const bookingIds: string[] = [];
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRoutes);
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.name === 'ZodError' ? 400 : error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.banAppeal.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { targetUserId: { in: userIds } }] } });
    await prisma.review.deleteMany({ where: { targetId: { in: userIds } } });
    await prisma.completedService.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });
  const createUser = async (name: string, role = 'user') => {
    const result = await prisma.user.create({ data: { name: `${name} ${suffix}`, email: `${name}-${suffix}@example.test`, phone: `test-${suffix}-${name}`, location: 'Cordova, Cebu', passwordHash: 'secret-must-not-be-returned', role, emailVerified: true, verificationStatus: 'APPROVED' } });
    userIds.push(result.id); return result;
  };
  const admin = await createUser('Admin', 'admin'), target = await createUser('Target'), peer = await createUser('Peer');
  const tokenFor = async (user: typeof admin) => {
    const session = await prisma.refreshToken.create({ data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
    return jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  };
  const adminToken = await tokenFor(admin), userToken = await tokenFor(peer);
  const call = async (path: string, token?: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/admin${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  for (const path of [`/users/${target.id}`, `/users/${target.id}/records?kind=trust`, '/ban-appeals/summary', '/ban-appeals?view=history']) {
    assert.equal((await call(path)).status, 401); assert.equal((await call(path, userToken)).status, 403);
  }
  const bookingA = await prisma.booking.create({ data: { seekerId: peer.id, providerId: target.id, originType: 'DIRECT_LISTING', status: 'COMPLETED', paymentMethod: 'On-site Cash', paymentStatus: 'CASH_CONFIRMED', agreedAmount: 500 } });
  const bookingB = await prisma.booking.create({ data: { seekerId: target.id, providerId: peer.id, originType: 'DIRECT_LISTING', status: 'COMPLETED', paymentMethod: 'On-site Cash', paymentStatus: 'CASH_CONFIRMED', agreedAmount: 700 } });
  bookingIds.push(bookingA.id, bookingB.id);
  for (const [booking, rating] of [[bookingA, 4], [bookingB, 5]] as const) {
    const completed = await prisma.completedService.create({ data: { bookingId: booking.id, seekerId: booking.seekerId, providerId: booking.providerId, finalPrice: booking.agreedAmount!, paymentStatus: 'CASH_CONFIRMED' } });
    await prisma.review.create({ data: { completedServiceId: completed.id, targetId: target.id, authorId: peer.id, rating, text: 'A real completed-booking review fixture.', editableUntil: new Date() } });
  }
  await prisma.trustScoreEvent.createMany({ data: Array.from({ length: 12 }, (_, index) => ({ userId: target.id, delta: 1, scoreBefore: index, scoreAfter: index + 1, reason: `Fixture ${index}` })) });
  const profile = await call(`/users/${target.id}`, adminToken);
  assert.equal(profile.status, 200); assert.match(profile.headers.get('cache-control') || '', /no-store/);
  assert.equal(profile.body.data.user.email, target.email);
  assert.equal(profile.body.data.ratings.provider.average, 4); assert.equal(profile.body.data.ratings.seeker.average, 5);
  assert.equal(profile.body.data.activity.completedAsProvider, 1); assert.equal(profile.body.data.activity.completedAsSeeker, 1);
  for (const secret of ['passwordHash', 'refreshTokens', 'passwordResetTokens', 'emailVerifTokens', 'token']) assert.equal(secret in profile.body.data.user, false);
  assert.equal(await prisma.adminAuditLog.count({ where: { actorId: admin.id, targetUserId: target.id, action: 'USER_PROFILE_VIEWED' } }), 1);
  const records = await call(`/users/${target.id}/records?kind=trust&limit=10&page=2`, adminToken);
  assert.equal(records.status, 200); assert.equal(records.body.pagination.total, 12); assert.equal(records.body.data.length, 2);
  const reviews = await call(`/users/${target.id}/records?kind=reviews`, adminToken);
  assert.deepEqual(reviews.body.data.map((row: any) => row.reviewContext).sort(), ['Provider', 'Seeker']);
  assert.equal((await call(`/users/${target.id}/records?kind=trust&limit=51`, adminToken)).status, 400);
  assert.equal((await call('/users/nonexistent-fixture', adminToken)).status, 404);
  const beforePending = (await call('/ban-appeals/summary', adminToken)).body.data.pending;
  await prisma.user.update({ where: { id: target.id }, data: { moderationStatus: 'BANNED', moderationReason: 'Original fixture ban reason' } });
  const ban = await prisma.adminAuditLog.create({ data: { actorId: admin.id, targetUserId: target.id, action: 'USER_BANNED', resourceType: 'User', resourceId: target.id, reason: 'Original fixture ban reason' } });
  const appeal = await prisma.banAppeal.create({ data: { userId: target.id, banAuditLogId: ban.id, message: 'Please review the evidence for my account ban.' } });
  assert.equal((await call(`/users/${target.id}`, adminToken)).status, 200, 'Admins can inspect a banned target');
  assert.equal((await call('/ban-appeals/summary', adminToken)).body.data.pending, beforePending + 1);
  assert.equal((await call('/ban-appeals?view=pending', adminToken)).body.data.some((row: any) => row.id === appeal.id), true);
  assert.equal((await call(`/ban-appeals/${appeal.id}`, adminToken, 'PATCH', { decision: 'APPROVED', reason: 'Evidence supports fixture account restoration.' })).status, 200);
  assert.equal((await call('/ban-appeals/summary', adminToken)).body.data.pending, beforePending);
  const historical = (await call('/ban-appeals?view=history', adminToken)).body.data.find((row: any) => row.id === appeal.id);
  assert.equal(historical.status, 'APPROVED'); assert.equal(historical.banAuditLog.reason, 'Original fixture ban reason');
  assert.equal(historical.user.moderationStatus, 'ACTIVE'); assert.match(historical.decisionReason, /restoration/);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingA.id } })).status, 'COMPLETED');
});
