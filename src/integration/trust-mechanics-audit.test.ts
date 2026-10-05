import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { googleLoginUser, registerUser } from '../services/auth/authentication.service';
import { reviewVerification } from '../services/verification.service';
import { applyManualTrustAdjustment, applyTrustEvent, reviewTrustDelta } from '../services/trust.service';
import { settleCompletedBooking, markJobComplete } from '../services/bookings/completion.service';
import { providerStartJob } from '../services/bookings/provider-operations.service';
import { submitReview, updateReview } from '../controllers/reviews.controller';
import { moderateReview } from '../controllers/admin/reviews.controller';
import { updateTrustScore } from '../controllers/admin/users.controller';
import { resolveAdminReport } from '../services/admin-report.service';
import { requestCancellation, respondToCancellationRequest, escalateCancellationRequest, adminResolveCancellationRequest } from '../services/cancellation.service';

// Regression verification for the trust audit findings.
// It refuses to run against the shared application schema.
test('trust mechanics audit against real services in a disposable schema', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') ?? '', /^audit_20260924_[a-f0-9]{32}$/);
  const previousKey = env.GEMINI_API_KEY;
  env.GEMINI_API_KEY = '';
  t.after(async () => { env.GEMINI_API_KEY = previousKey; await prisma.$disconnect(); });
  const tag = randomUUID();
  let serial = 0;
  const password = 'AuditOnlyPassword123!';
  const passwordHash = await bcrypt.hash(password, 4);
  const account = (score = 50, role = 'user') => prisma.user.create({ data: {
    name: `Trust audit ${++serial}`, email: `trust-${serial}-${tag}@example.test`, passwordHash,
    phone: '', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED', trustScore: score, role,
  } });
  const admin = await account(50, 'admin');
  const score = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).trustScore;
  const invoke = async (handler: typeof submitReview, userId: string, body: object, id?: string) => {
    let code = 200;
    let data: unknown;
    let error: unknown;
    const res = { status(value: number) { code = value; return this; }, json(value: unknown) { data = value; return this; } };
    await handler({ user: { id: userId, role: userId === admin.id ? 'admin' : 'user' }, body, params: { id } } as never,
      res as never, value => { error = value; });
    if (error) throw error;
    return { code, data: data as { data?: { id: string } } };
  };
  const completed = async (providerId: string, seekerId: string) => {
    const booking = await prisma.booking.create({ data: { providerId, seekerId, agreedAmount: 500, started: true,
      status: 'COMPLETED', paymentMethod: 'On-site Cash', paymentStatus: 'CASH_CONFIRMED' } });
    return prisma.completedService.create({ data: { providerId, seekerId, bookingId: booking.id, finalPrice: 500, paymentStatus: 'CASH_CONFIRMED' } });
  };

  await t.test('password signup starts at 50 with an atomic baseline event', async sub => {
    sub.mock.method(console, 'log', () => {}); // Do not print disposable verification links.
    const result = await registerUser({ name: 'Trust signup audit', email: `signup-${tag}@example.test`, password, phone: '09171234567', location: 'Cordova' });
    assert.equal(result.user.trustScore, 50);
    const events = await prisma.trustScoreEvent.findMany({ where: { userId: result.user.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0].delta, 50);
    assert.equal(events[0].scoreBefore, 0);
    assert.equal(events[0].scoreAfter, 50);
  });

  await t.test('first residency approval adds 5 only once across later submissions', async () => {
    const user = await account();
    for (let i = 0; i < 2; i++) {
      await prisma.user.update({ where: { id: user.id }, data: { verificationStatus: 'PENDING_REVIEW' } });
      const verification = await prisma.serviceVerification.create({ data: { userId: user.id, status: 'PENDING_REVIEW',
        privacyNoticeVersion: 'audit', privacyAcknowledgedAt: new Date(), privacyAcknowledgedBy: user.id,
        retentionUntil: new Date(Date.now() + 86400000) } });
      await reviewVerification(verification.id, admin.id, true, 'Disposable trust audit approval');
    }
    assert.equal(await score(user.id), 55);
    assert.equal(await prisma.trustScoreEvent.count({ where: { eventKey: `verification-approval:${user.id}` } }), 1);
  });

  await t.test('Google signup creates its baseline atomically and repeat login does not award another baseline', async sub => {
    const previousClient = env.GOOGLE_CLIENT_ID;
    env.GOOGLE_CLIENT_ID = 'audit-google-client';
    sub.after(() => { env.GOOGLE_CLIENT_ID = previousClient; });
    sub.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ aud: env.GOOGLE_CLIENT_ID,
      iss: 'accounts.google.com', sub: `audit-google-${tag}`, email: `google-${tag}@example.test`, name: 'Google trust audit',
      email_verified: 'true', exp: Math.floor(Date.now() / 1000) + 3600 })));
    const first = await googleLoginUser('disposable-audit-token');
    const second = await googleLoginUser('disposable-audit-token');
    assert.equal(first.user.id, second.user.id); assert.equal(await score(first.user.id), 50);
    assert.equal(await prisma.trustScoreEvent.count({ where: { userId: first.user.id } }), 1);
  });

  await t.test('cash start and mark-complete give no bonus; confirmed completion awards provider 3 exactly once', async () => {
    const provider = await account(); const seeker = await account();
    const booking = await prisma.booking.create({ data: { providerId: provider.id, seekerId: seeker.id, status: 'ACCEPTED',
      agreedAmount: 500, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID' } });
    await providerStartJob(booking.id, provider.id);
    await markJobComplete(booking.id, provider.id);
    assert.equal(await score(provider.id), 50);
    const first = await settleCompletedBooking(booking.id, { type: 'SEEKER', userId: seeker.id });
    const retry = await settleCompletedBooking(booking.id, { type: 'SEEKER', userId: seeker.id });
    assert.equal(first.id, retry.id);
    assert.equal(await score(provider.id), 53);
    assert.equal(await score(seeker.id), 50);
    assert.equal(await prisma.trustScoreEvent.count({ where: { eventKey: `booking-completion:${booking.id}:provider` } }), 1);
  });

  await t.test('online and admin dispute completion share the same one-time provider reward', async () => {
    for (const administrative of [false, true]) {
      const provider = await account(); const seeker = await account();
      const booking = await prisma.booking.create({ data: { providerId: provider.id, seekerId: seeker.id, started: true,
        status: administrative ? 'DISPUTED' : 'AWAITING_CONFIRMATION', statusBeforeDispute: administrative ? 'AWAITING_CONFIRMATION' : null,
        agreedAmount: 500, paymentMethod: 'GCash', paymentStatus: administrative ? 'FROZEN_HELD' : 'PAID_HELD' } });
      const actor = administrative ? { type: 'ADMIN' as const, userId: admin.id } : { type: 'SEEKER' as const, userId: seeker.id };
      await settleCompletedBooking(booking.id, actor); await settleCompletedBooking(booking.id, actor);
      assert.equal(await score(provider.id), 53); assert.equal(await score(seeker.id), 50);
      assert.equal(await prisma.transaction.count({ where: { walletOwnerId: provider.id } }), 1);
    }
  });

  await t.test('all five ratings affect both provider and seeker review targets; duplicate review gives no extra points', async () => {
    for (const targetRole of ['provider', 'seeker']) for (const rating of [1, 2, 3, 4, 5]) {
      const provider = await account(); const seeker = await account();
      const service = await completed(provider.id, seeker.id);
      const authorId = targetRole === 'provider' ? seeker.id : provider.id;
      const targetId = targetRole === 'provider' ? provider.id : seeker.id;
      const body = { completedServiceId: service.id, rating };
      const first = await invoke(submitReview, authorId, body);
      assert.equal(first.code, 201); assert.equal(await score(targetId), 50 + reviewTrustDelta(rating));
      const retry = await invoke(submitReview, authorId, body);
      assert.equal(retry.code, 409); assert.equal(await score(targetId), 50 + reviewTrustDelta(rating));
      assert.equal(await score(authorId), 50);
    }
  });

  await t.test('rating edits use net differences; hiding and restoring reviews reverse them away from score boundaries', async () => {
    const provider = await account(); const seeker = await account(); const service = await completed(provider.id, seeker.id);
    const review = await invoke(submitReview, seeker.id, { completedServiceId: service.id, rating: 5 });
    const id = review.data.data!.id;
    assert.equal(await score(provider.id), 52);
    await invoke(updateReview, seeker.id, { rating: 1 }, id); assert.equal(await score(provider.id), 45);
    await invoke(updateReview, seeker.id, { rating: 1 }, id); assert.equal(await score(provider.id), 45);
    await invoke(moderateReview, admin.id, { action: 'hide', reason: 'Audit hide' }, id); assert.equal(await score(provider.id), 50);
    await invoke(moderateReview, admin.id, { action: 'restore', reason: 'Audit restore' }, id); assert.equal(await score(provider.id), 45);
  });

  await t.test('engine serializes concurrent duplicate events and clamps actual deltas at both boundaries', async () => {
    const user = await account(99); const key = `audit-trust:${tag}`;
    await Promise.all(Array.from({ length: 3 }, () => applyTrustEvent(user.id, 3, 'Audit duplicate event', undefined, key)));
    assert.equal(await score(user.id), 100);
    const event = await prisma.trustScoreEvent.findUniqueOrThrow({ where: { eventKey: key } });
    assert.equal(event.delta, 1); assert.equal(event.scoreBefore, 99); assert.equal(event.scoreAfter, 100);
    await applyTrustEvent(user.id, -200, 'Audit lower clamp', undefined, `${key}:lower`);
    assert.equal(await score(user.id), 0);
    assert.equal((await prisma.trustScoreEvent.findUniqueOrThrow({ where: { eventKey: `${key}:lower` } })).delta, -100);
  });

  await t.test('manual admin adjustments require reauthentication and stable retry identity', async () => {
    const target = await account(); const operationId = randomUUID();
    const body = { delta: -5, reason: 'Disposable trust audit', currentPassword: 'wrong-password', operationId };
    assert.equal((await invoke(updateTrustScore, admin.id, body, target.id)).code, 403);
    assert.equal(await score(target.id), 50);
    body.currentPassword = password;
    await invoke(updateTrustScore, admin.id, body, target.id); await invoke(updateTrustScore, admin.id, body, target.id);
    assert.equal(await score(target.id), 45);
    assert.equal(await prisma.adminAuditLog.count({ where: { targetUserId: target.id, action: 'TRUST_SCORE_ADJUSTED' } }), 1);
    await assert.rejects(applyManualTrustAdjustment({ userId: target.id, adminId: admin.id, delta: -10, reason: body.reason, operationId }), /different details/);
  });

  await t.test('validated reports deduct 10 only when admin selects trust_deduct; default none leaves score unchanged', async () => {
    for (const penalty of ['trust_deduct', 'none'] as const) {
      const provider = await account(); const seeker = await account(); const service = await completed(provider.id, seeker.id);
      const report = await prisma.report.create({ data: { bookingId: service.bookingId!, reporterId: seeker.id, reportedUserId: provider.id,
        reportType: 'SAFETY', reason: 'INAPPROPRIATE_BEHAVIOR', description: 'Disposable supported finding audit' } });
      assert.equal(await score(provider.id), 50);
      await resolveAdminReport(report.id, admin.id, 'resolve_safety', 'Evidence confirms the reported behavior', penalty);
      await resolveAdminReport(report.id, admin.id, 'resolve_safety', 'Evidence confirms the reported behavior', penalty);
      assert.equal(await score(provider.id), penalty === 'trust_deduct' ? 40 : 50);
      assert.equal(await score(seeker.id), 50);
    }
  });

  await t.test('admin cancellation deducts 5 from only the explicitly identified at-fault participant, once; no-fault is neutral', async () => {
    for (const fault of ['provider', 'seeker', 'none'] as const) {
    const provider = await account(); const seeker = await account();
    const booking = await prisma.booking.create({ data: { providerId: provider.id, seekerId: seeker.id, status: 'ONGOING', started: true,
      agreedAmount: 500, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID' } });
    const request = await requestCancellation(booking.id, seeker.id, 'Provider abandoned the started work');
    assert.equal(request.immediate, false);
    const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: booking.id } });
    await respondToCancellationRequest(row.id, provider.id, false, 'Disputed reason');
    await escalateCancellationRequest(row.id, seeker.id);
    const notes = fault === 'none' ? 'Mutual cancellation; no fault established' : `Audit finding: ${fault} at fault for cancelling started work`;
    await adminResolveCancellationRequest(row.id, true, notes, admin.id, fault);
    await adminResolveCancellationRequest(row.id, true, notes, admin.id, fault);
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'CANCELED');
    assert.equal(await score(provider.id), fault === 'provider' ? 45 : 50);
    assert.equal(await score(seeker.id), fault === 'seeker' ? 45 : 50);
    assert.equal(await prisma.trustScoreEvent.count({ where: { userId: { in: [provider.id, seeker.id] } } }), fault === 'none' ? 0 : 1);
    if (fault !== 'none') await assert.rejects(adminResolveCancellationRequest(row.id, true, notes, admin.id, 'none'), /different cancellation decision/);
    }
  });

  await t.test('pre-start and denied cancellations cannot assign a fault penalty; ordinary pre-start cancellation is neutral', async () => {
    const provider = await account(); const seeker = await account();
    const booking = await prisma.booking.create({ data: { providerId: provider.id, seekerId: seeker.id, status: 'ACCEPTED',
      agreedAmount: 500, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID' } });
    const row = await prisma.cancellationRequest.create({ data: { bookingId: booking.id, requestedBy: seeker.id, responderId: provider.id, status: 'ESCALATED', reason: 'Audit only' } });
    await assert.rejects(adminResolveCancellationRequest(row.id, true, 'Invalid pre-start finding', admin.id, 'provider'), /only after work has started/);
    await assert.rejects(adminResolveCancellationRequest(row.id, false, 'Invalid denial penalty', admin.id, 'seeker'), /valid fault finding/);
    await prisma.cancellationRequest.update({ where: { id: row.id }, data: { status: 'RESOLVED' } });
    await requestCancellation(booking.id, seeker.id, 'Plans changed before work started');
    assert.equal(await score(provider.id), 50); assert.equal(await score(seeker.id), 50);
  });

  await t.test('hiding a clamped review never reverses points that were not applied', async () => {
    for (const boundary of [100, 0]) {
      const provider = await account(boundary); const seeker = await account(); const service = await completed(provider.id, seeker.id);
      const review = await invoke(submitReview, seeker.id, { completedServiceId: service.id, rating: boundary === 100 ? 5 : 1 });
      const id = review.data.data!.id;
      assert.equal(await score(provider.id), boundary);
      assert.equal((await prisma.trustScoreEvent.findUniqueOrThrow({ where: { eventKey: `review:${id}:rating:v1` } })).delta, 0);
      await invoke(moderateReview, admin.id, { action: 'hide', reason: 'Audit clamped review reversal' }, id);
      assert.equal(await score(provider.id), boundary);
      await invoke(updateReview, seeker.id, { rating: 3 }, id);
      await invoke(moderateReview, admin.id, { action: 'restore', reason: 'Audit edited neutral review restoration' }, id);
      assert.equal(await score(provider.id), boundary);
    }
  });

  await t.test('editing a boundary-clamped review reconciles its actual award and repeated edits cannot farm points', async () => {
    const provider = await account(100); const seeker = await account(); const service = await completed(provider.id, seeker.id);
    const review = await invoke(submitReview, seeker.id, { completedServiceId: service.id, rating: 5 });
    const id = review.data.data!.id;
    await invoke(updateReview, seeker.id, { rating: 4 }, id); assert.equal(await score(provider.id), 100);
    await invoke(updateReview, seeker.id, { rating: 1 }, id); assert.equal(await score(provider.id), 95);
    await invoke(updateReview, seeker.id, { rating: 5 }, id); assert.equal(await score(provider.id), 100);
    await invoke(updateReview, seeker.id, { rating: 5 }, id); assert.equal(await score(provider.id), 100);
  });
});
