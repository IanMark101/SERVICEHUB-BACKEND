import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { createDirectRequest, respondToDirectBookingService } from '../services/bookings/direct-bookings.service';
import { providerStartJob } from '../services/bookings/provider-operations.service';
import { markJobComplete, confirmCompletionService } from '../services/bookings/completion.service';
import { requestCancellation, respondToCancellationRequest, escalateCancellationRequest } from '../services/cancellation.service';
import { recordBookingProgress } from '../services/booking-progress.service';
import { getMyEngagements } from '../controllers/bookings/engagements.controller';
import { startModerationReview } from '../services/admin-case-workspace.service';

test('booking action history is transactional, shared, ordered, and retry safe', async t => {
  // This test must never write fixtures into the deployed application's schema.
  const schemaName = new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '';
  assert.match(schemaName, /^servicehub_migration_test_[a-f0-9]{32}$/);
  const [connection] = await prisma.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
  assert.equal(connection.schema, schemaName, 'Raw SQL must also target the disposable schema');
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const users: string[] = [];
  let categoryId: string | undefined;
  t.after(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.adminResolutionOperation.deleteMany({ where: { requestedByAdminId: { in: users } } });
    await prisma.completedService.deleteMany({ where: { seekerId: { in: users } } });
    await prisma.booking.deleteMany({ where: { seekerId: { in: users } } });
    await prisma.directRequest.deleteMany({ where: { seekerId: { in: users } } });
    await prisma.service.deleteMany({ where: { providerId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    if (categoryId) await prisma.category.delete({ where: { id: categoryId } });
    await prisma.$disconnect();
  });
  async function user(name: string, role: 'user' | 'admin' = 'user') {
    const value = await prisma.user.create({ data: { name, email: `${name}-${suffix}@example.test`, passwordHash: 'test-only',
      phone: `09${Math.floor(100_000_000 + Math.random() * 899_999_999)}`, location: 'Cordova, Cebu', role, emailVerified: true, verificationStatus: 'APPROVED' } });
    users.push(value.id); return value;
  }
  const seeker = await user('Seeker'), provider = await user('Provider'), outsider = await user('Outsider');
  const admin = await user('Admin', 'admin');
  const category = await prisma.category.create({ data: { name: `Progress ${suffix}` } });
  categoryId = category.id;
  const service = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Repair ${suffix}`,
    titleNormalized: `repair ${suffix}`, description: 'Booking history integration fixture', price: 200, priceType: 'FIXED',
    serviceType: 'ONE_TIME', estimatedDurationMins: 60, queueLimit: 3, paymentMethods: { cash: true, gcash: false }, status: 'ACTIVE', isAvailable: true } });
  const events = (bookingId: string) => prisma.bookingProgressEvent.findMany({ where: { bookingId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  async function acceptedBooking() {
    const request = await createDirectRequest({ seekerId: seeker.id, providerId: provider.id, serviceId: service.id });
    const accepted = await respondToDirectBookingService(request.id, provider.id, true);
    assert.ok(accepted); return accepted;
  }

  const before = new Date();
  const booking = await acceptedBooking();
  assert.equal((await events(booking.id))[0].kind, 'ACCEPTED');
  assert.equal((await events(booking.id))[0].actorRole, 'PROVIDER');
  await assert.rejects(providerStartJob(booking.id, outsider.id));
  assert.equal((await events(booking.id)).length, 1);
  await providerStartJob(booking.id, provider.id);
  await markJobComplete(booking.id, provider.id);
  const firstComplete = (await events(booking.id)).find(event => event.kind === 'WORK_MARKED_COMPLETE');
  await markJobComplete(booking.id, provider.id);
  await assert.rejects(confirmCompletionService(booking.id, provider.id));
  assert.deepEqual((await events(booking.id)).find(event => event.kind === 'WORK_MARKED_COMPLETE'), firstComplete);
  await confirmCompletionService(booking.id, seeker.id);
  const completedEvents = await events(booking.id);
  await confirmCompletionService(booking.id, seeker.id);
  assert.deepEqual(await events(booking.id), completedEvents);
  assert.deepEqual(completedEvents.map(event => [event.kind, event.actorRole]), [
    ['ACCEPTED', 'PROVIDER'], ['STARTED', 'PROVIDER'], ['WORK_MARKED_COMPLETE', 'PROVIDER'], ['COMPLETION_CONFIRMED', 'SEEKER'],
  ]);
  for (const event of completedEvents) assert.ok(event.occurredAt >= before && event.occurredAt <= new Date());
  const completed = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.paymentStatus, 'CASH_CONFIRMED');
  assert.equal(Number(completed.agreedAmount), 200); assert.equal(await prisma.queue.count({ where: { bookingId: booking.id } }), 0);
  assert.equal(await prisma.transaction.count({ where: { relatedBookingId: booking.id } }), 0);
  await assert.rejects(prisma.$transaction(async tx => {
    await recordBookingProgress(tx, booking.id, 'CANCELLATION_REQUESTED', 'SEEKER', 'rollback-fixture');
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual(await events(booking.id), completedEvents);

  async function engagements(userId: string) {
    let payload: any;
    await getMyEngagements({ user: { id: userId } } as unknown as Request,
      { json: (value: unknown) => { payload = value; } } as Response, error => { if (error) throw error; });
    return payload.data;
  }
  const seekerData = await engagements(seeker.id), providerData = await engagements(provider.id);
  assert.deepEqual(seekerData.bookings[0].progressEvents, providerData.bookings[0].progressEvents);
  assert.deepEqual(seekerData.completedServices[0].booking.progressEvents, seekerData.bookings[0].progressEvents);
  assert.equal((await engagements(outsider.id)).bookings.length, 0);

  const active = await acceptedBooking();
  await providerStartJob(active.id, provider.id);
  const claim = await requestCancellation(active.id, provider.id, 'Cannot continue the appointment');
  assert.ok('request' in claim && claim.request);
  const request = claim.request;
  await requestCancellation(active.id, provider.id, 'Retry');
  assert.equal((await events(active.id)).filter(event => event.kind === 'CANCELLATION_REQUESTED').length, 1);
  await respondToCancellationRequest(request.id, seeker.id, false, 'Please continue the work');
  await escalateCancellationRequest(request.id, provider.id);
  const escalated = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: request.id } });
  await startModerationReview('report', escalated.reportId!, admin.id);
  // A later approval must retain the earlier decline and escalation times.
  await respondToCancellationRequest(request.id, seeker.id, true, 'Now I agree to cancel');
  const cancelEvents = await events(active.id);
  await respondToCancellationRequest(request.id, seeker.id, true);
  assert.deepEqual(await events(active.id), cancelEvents);
  assert.deepEqual(cancelEvents.map(event => [event.kind, event.actorRole]), [
    ['ACCEPTED', 'PROVIDER'], ['STARTED', 'PROVIDER'], ['CANCELLATION_REQUESTED', 'PROVIDER'],
    ['CANCELLATION_DECLINED', 'SEEKER'], ['CANCELLATION_ESCALATED', 'PROVIDER'], ['CANCELLATION_APPROVED', 'SEEKER'], ['CANCELED', 'SEEKER'],
  ]);
  const canceled = await prisma.booking.findUniqueOrThrow({ where: { id: active.id } });
  assert.equal(canceled.status, 'CANCELED'); assert.equal(canceled.paymentStatus, 'UNPAID');
  assert.equal(await prisma.paymentRefund.count({ where: { bookingId: active.id } }), 0);

  const immediate = await acceptedBooking();
  await requestCancellation(immediate.id, seeker.id, 'Cancel before starting');
  assert.deepEqual((await events(immediate.id)).map(event => [event.kind, event.actorRole]), [
    ['ACCEPTED', 'PROVIDER'], ['CANCELLATION_REQUESTED', 'SEEKER'], ['CANCELED', 'SEEKER'],
  ]);
});
