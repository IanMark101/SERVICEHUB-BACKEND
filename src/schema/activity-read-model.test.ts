import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';

// Install the singleton before importing controllers. This isolated test process
// never creates a database pool or reads/writes application records.
test('Activity read models preserve historical detail metadata', async t => {
  const decisionAt = new Date('2026-10-03T05:15:00.000Z');
  const offers = t.mock.fn(async (_query?: Prisma.OfferFindManyArgs) => [{ id: 'offer', status: 'REJECTED', estimatedDuration: 90 }]);
  const decisions = t.mock.fn(async (_query?: Prisma.NotificationFindManyArgs) => [{ id: 'offer-declined:offer', createdAt: decisionAt }]);
  const bookings = t.mock.fn(async (_query?: Prisma.BookingFindManyArgs) => []);
  const completed = t.mock.fn(async (_query?: Prisma.CompletedServiceFindManyArgs) => []);
  const singleton = globalThis as unknown as { prisma?: PrismaClient };
  const previous = singleton.prisma;
  singleton.prisma = {
    offer: { findMany: offers }, notification: { findMany: decisions },
    booking: { findMany: bookings }, completedService: { findMany: completed },
  } as unknown as PrismaClient;
  t.after(() => { singleton.prisma = previous; });
  const { getMine } = await import('../controllers/offers.controller');
  const { getMyEngagements } = await import('../controllers/bookings/engagements.controller');

  await t.test('Provider offers retain participant metadata and the recorded decision timestamp', async () => {
  let body: { data: Array<{ decisionReason: string; decisionAt: Date }> } | undefined;
  let failure: unknown;
  await getMine({ user: { id: 'provider' } } as unknown as Request,
    { json: (value: typeof body) => { body = value; } } as unknown as Response,
    error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(body?.data[0].decisionReason, 'DECLINED');
  assert.equal(body?.data[0].decisionAt, decisionAt);
  const query = offers.mock.calls[0].arguments[0]!;
  assert.deepEqual(query.where, { providerId: 'provider' });
  assert.equal(query.include?.request && typeof query.include.request === 'object' && query.include.request.select?.seeker && typeof query.include.request.select.seeker === 'object' && query.include.request.select.seeker.select?.avatarUrl, true);
  assert.equal(query.include?.request && typeof query.include.request === 'object' && query.include.request.select?.seeker && typeof query.include.request.select.seeker === 'object' && query.include.request.select.seeker.select?.trustScore, true);
  assert.deepEqual(decisions.mock.calls[0].arguments[0]?.select, { id: true, createdAt: true });
  });

  await t.test('Activity bookings return their own categories rather than relying on active marketplace lists', async () => {
  let failure: unknown;
  await getMyEngagements({ user: { id: 'provider' } } as unknown as Request,
    { json: () => {} } as unknown as Response, error => { failure = error; });
  assert.equal(failure, undefined);
  const query = bookings.mock.calls[0].arguments[0]!;
  assert.deepEqual(query.where?.OR, [{ seekerId: 'provider', hiddenBySeeker: false }, { providerId: 'provider', hiddenByProvider: false }]);
  const include = query.include!;
  assert.deepEqual(include.service && typeof include.service === 'object' && include.service.select?.category, { select: { name: true } });
  assert.deepEqual(include.offer && typeof include.offer === 'object' && include.offer.include?.request && typeof include.offer.include.request === 'object' && include.offer.include.request.select?.category, { select: { name: true } });
  const history = completed.mock.calls[0].arguments[0]?.include?.booking;
  assert.ok(history && typeof history === 'object' && history.include?.service && typeof history.include.service === 'object' && history.include.service.select?.category);
  });
});
