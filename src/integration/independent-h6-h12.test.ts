import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { resetPassword, logoutUser, refreshAccessToken, loginUser } from '../services/auth/authentication.service';
import { requireAuth } from '../middlewares/auth.middleware';
import { reviewVerification } from '../services/verification.service';
import { updateRequest } from '../services/requests.service';
import { rejectOffer, submitOffer } from '../services/offers.service';
import { createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { updateTrustScore, suspendUser } from '../controllers/admin/users.controller';
import { deleteOwnAccount } from '../services/account-deletion.service';
import { finalizeSuccessfulPayment } from '../services/payment-attempt.service';
import { getUserActiveCaseCounts } from '../services/data-retention.service';

// Prisma exposes delegate methods through a proxy, not own descriptors, so
// node:test mock.method cannot patch them. Restore each override after its test.
function overrideDelegate(sub: { after: (fn: () => void) => void }, delegate: any, method: string, replacement: (...args: any[]) => any) {
  const original = delegate[method];
  delegate[method] = replacement;
  const restore = () => { delegate[method] = original; };
  sub.after(restore);
  return { restore };
}

// Desired-behavior regressions for the independently confirmed findings.
test('independent H6-H12 regressions in an isolated schema', async (t) => {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^audit_20260924_[a-f0-9]{32}$/);
  t.after(() => prisma.$disconnect());
  let serial = 0;
  const user = (role = 'user') => prisma.user.create({ data: { name: `Audit ${++serial}`, email: `h6h12-${serial}@example.test`, phone: `audit-${serial}`, location: 'Cordova', passwordHash: 'test-only', role, emailVerified: true, verificationStatus: 'APPROVED' } });
  const admin = await user('admin');
  const seeker = await user();
  const provider = await user();
  const category = await prisma.category.create({ data: { name: 'Independent H6-H12' } });
  const market = async () => {
    const id = ++serial;
    const service = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Audit service ${id}`, titleNormalized: `audit service ${id}`, description: 'Independent audit fixture only', price: 650, estimatedDurationMins: 30, status: 'ACTIVE', isAvailable: true, paymentMethods: { cash: true, gcash: true }, queueLimit: 5 } });
    const request = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id, title: `Audit request ${id}`, description: 'Independent audit fixture', budgetMin: 500, budgetMax: 700, urgency: 'medium' } });
    return { service, request };
  };
  const response = () => {
    const result = { code: 200, body: undefined as unknown };
    const res = { status(code: number) { result.code = code; return this; }, json(body: unknown) { result.body = body; return this; } };
    return { result, res };
  };

  await t.test('H7: logout revokes only its session access token', async () => {
    const target = await user();
    const refresh = 'audit-only-refresh';
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const session = await prisma.refreshToken.create({ data: { userId: target.id, token: hash(refresh), expiresAt: new Date(Date.now() + 60000) } });
    const other = await prisma.refreshToken.create({ data: { userId: target.id, token: hash('other-device'), expiresAt: new Date(Date.now() + 60000) } });
    const access = jwt.sign({ sub: target.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    await logoutUser(refresh);
    let authorized = false;
    const { result, res } = response();
    await requireAuth({ headers: { authorization: `Bearer ${access}` } } as never, res as never, () => { authorized = true; });
    assert.equal(authorized, false);
    assert.equal(result.code, 401);
    assert.equal(await prisma.refreshToken.count({ where: { userId: target.id } }), 1);
    assert.ok(await prisma.refreshToken.findUnique({ where: { id: other.id } }));
  });

  await t.test('H7: logout with a signed pre-rotation cookie still revokes this browser session', async () => {
    const target = await user();
    await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await bcrypt.hash('CurrentPassword123!', 10) } });
    const { tokens } = await loginUser({ email: target.email, password: 'CurrentPassword123!' });
    const originalClaims = jwt.verify(tokens.refreshToken, env.JWT_REFRESH_SECRET) as { sid: string };
    assert.ok(originalClaims.sid);
    const replacement = await refreshAccessToken(tokens.refreshToken);
    await logoutUser(tokens.refreshToken);
    assert.equal(await prisma.refreshToken.count({ where: { id: originalClaims.sid } }), 0);
    await assert.rejects(refreshAccessToken(replacement.refreshToken), /not found or expired/);
  });

  await t.test('H7: password reset revokes every session access token', async () => {
    const target = await user();
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const session = await prisma.refreshToken.create({ data: { userId: target.id, token: hash('reset-device'), expiresAt: new Date(Date.now() + 60000) } });
    const access = jwt.sign({ sub: target.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const reset = 'audit-only-reset';
    await prisma.passwordResetToken.create({ data: { userId: target.id, token: hash(reset), expiresAt: new Date(Date.now() + 60000) } });
    await resetPassword(reset, 'IndependentTest123!');
    let authorized = false;
    const { result, res } = response();
    await requireAuth({ headers: { authorization: `Bearer ${access}` } } as never, res as never, () => { authorized = true; });
    assert.equal(await prisma.refreshToken.count({ where: { userId: target.id } }), 0);
    assert.equal(authorized, false);
    assert.equal(result.code, 401);
  });

  await t.test('H7: database failure propagates instead of becoming invalid-token 401', async (sub) => {
    const session = await prisma.refreshToken.create({ data: { userId: seeker.id, token: createHash('sha256').update('db-failure-session').digest('hex'), expiresAt: new Date(Date.now() + 60000) } });
    const token = jwt.sign({ sub: seeker.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    overrideDelegate(sub, prisma.user, 'findUnique', async () => { throw new Error('Injected database timeout'); });
    const { result, res } = response();
    let passedError: unknown;
    await requireAuth({ headers: { authorization: `Bearer ${token}` } } as never, res as never, error => { passedError = error; });
    assert.equal(result.body, undefined);
    assert.match(String(passedError), /Injected database timeout/);
  });

  await t.test('H6/H7: failed refresh replacement leaves the old cookie usable', async (sub) => {
    const target = await user();
    const token = jwt.sign({ sub: target.id, jti: 'independent-refresh' }, env.JWT_REFRESH_SECRET, { expiresIn: '1h' });
    await prisma.refreshToken.create({ data: { userId: target.id, token: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60000) } });
    const stub = overrideDelegate(sub, prisma.refreshToken, 'updateMany', async () => { throw new Error('Injected replacement failure'); });
    await assert.rejects(refreshAccessToken(token), /Injected replacement failure/);
    stub.restore();
    assert.equal(await prisma.refreshToken.count({ where: { userId: target.id } }), 1);
    const replacement = await refreshAccessToken(token);
    assert.ok(replacement.accessToken);
    assert.equal(await prisma.refreshToken.count({ where: { userId: target.id } }), 1);
  });

  await t.test('H7: only one caller can consume a reset token', async (sub) => {
    const target = await user();
    const token = 'independent-concurrent-reset';
    await prisma.passwordResetToken.create({ data: { userId: target.id, token: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60000) } });
    const original = prisma.passwordResetToken.findUnique.bind(prisma.passwordResetToken);
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    overrideDelegate(sub, prisma.passwordResetToken, 'findUnique', async (args: any) => {
      const row = await original(args);
      if (++reads === 2) release();
      await gate;
      return row;
    });
    const results = await Promise.allSettled([resetPassword(token, 'FirstNewPassword123!'), resetPassword(token, 'SecondNewPassword123!')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  });

  await t.test('H8: one pending verification and one lifetime first-approval reward', async () => {
    const target = await user();
    await prisma.user.update({ where: { id: target.id }, data: { verificationStatus: 'PENDING_REVIEW' } });
    const pending = () => prisma.serviceVerification.create({ data: { userId: target.id, status: 'PENDING_REVIEW', privacyNoticeVersion: 'audit', privacyAcknowledgedAt: new Date(), privacyAcknowledgedBy: target.id, retentionUntil: new Date(Date.now() + 86400000) } });
    const first = await pending();
    await assert.rejects(pending());
    await reviewVerification(first.id, admin.id, true, 'Audit approval');
    await prisma.user.update({ where: { id: target.id }, data: { verificationStatus: 'PENDING_REVIEW' } });
    const second = await pending();
    await reviewVerification(second.id, admin.id, true, 'Audit approval');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).trustScore, 55);
    assert.equal(await prisma.trustScoreEvent.count({ where: { userId: target.id } }), 1);
  });

  await t.test('H9: completed linked request cannot be reopened', async () => {
    const { service, request } = await market();
    const offer = await prisma.offer.create({ data: { requestId: request.id, providerId: provider.id, serviceId: service.id, offeredPrice: 650, estimatedDuration: 30, status: 'ACCEPTED' } });
    const booking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: service.id, offerId: offer.id, originType: 'OFFER', agreedAmount: 650, paymentMethod: 'On-site Cash', paymentStatus: 'CASH_CONFIRMED', status: 'COMPLETED', started: true } });
    await prisma.completedService.create({ data: { bookingId: booking.id, seekerId: seeker.id, providerId: provider.id, finalPrice: 650, paymentStatus: 'CASH_CONFIRMED' } });
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { status: 'CLOSED' } });
    await assert.rejects(updateRequest(request.id, seeker.id, { status: 'OPEN' }), /fulfilled or payment-pending/);
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'CLOSED');
  });

  await t.test('H9: stale withdrawal cannot overwrite an accepted offer', async (sub) => {
    const { service, request } = await market();
    const offer = await prisma.offer.create({ data: { requestId: request.id, providerId: provider.id, serviceId: service.id, offeredPrice: 650, estimatedDuration: 30 } });
    const original = prisma.offer.findUnique.bind(prisma.offer);
    let first = true;
    let signal!: () => void;
    let release!: () => void;
    const read = new Promise<void>(resolve => { signal = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stub = overrideDelegate(sub, prisma.offer, 'findUnique', async (args: any) => {
      const row = await original(args);
      if (first) { first = false; signal(); await gate; }
      return row;
    });
    const withdrawal = rejectOffer(offer.id, provider.id);
    await read;
    try { await createDirectFromOfferService(offer.id, seeker.id); } finally { release(); }
    await assert.rejects(withdrawal, /pending unpaid offer/);
    stub.restore();
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status, 'ACCEPTED');
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { offerId: offer.id } })).status, 'ACCEPTED');
  });

  await t.test('H9: simultaneous duplicate offer submissions commit once', async () => {
    const { service, request } = await market();
    const input = { requestId: request.id, serviceId: service.id, offeredPrice: 650, estimatedDuration: 30 };
    const results = await Promise.allSettled([submitOffer(provider.id, input), submitOffer(provider.id, input)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(await prisma.offer.count({ where: { requestId: request.id, providerId: provider.id, status: 'PENDING' } }), 1);
  });

  await t.test('H11: admin reauth and stable retry identity prevent duplicate trust adjustments', async () => {
    const target = await user();
    await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash('AdminCurrent123!', 10) } });
    const operationId = randomUUID();
    const req = { user: { id: admin.id }, params: { id: target.id }, body: { delta: -5, reason: 'Independent duplicate retry audit', currentPassword: 'AdminCurrent123!', operationId } };
    const noPassword = { ...req, body: { delta: -5, reason: req.body.reason, operationId } };
    let missingPasswordError: unknown;
    const missingResponse = response();
    await updateTrustScore(noPassword as never, missingResponse.res as never, error => { missingPasswordError = error; });
    assert.ok(missingPasswordError);
    const wrongPassword = { ...req, body: { ...req.body, currentPassword: 'wrong-password' } };
    const denied = response();
    await updateTrustScore(wrongPassword as never, denied.res as never, error => { if (error) throw error; });
    assert.equal(denied.result.code, 403);
    for (let i = 0; i < 2; i++) {
      const { res } = response();
      await updateTrustScore(req as never, res as never, error => { if (error) throw error; });
    }
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).trustScore, 45);
    assert.equal(await prisma.trustScoreEvent.count({ where: { userId: target.id } }), 1);
    let conflict: any;
    const changed = { ...req, body: { ...req.body, delta: -10 } };
    await updateTrustScore(changed as never, response().res as never, error => { conflict = error; });
    assert.equal(conflict?.status, 409);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).trustScore, 45);

    const boundaryId = randomUUID();
    const boundary = { ...req, body: { ...req.body, delta: -100, operationId: boundaryId } };
    for (let i = 0; i < 2; i++) {
      await updateTrustScore(boundary as never, response().res as never, error => { if (error) throw error; });
    }
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).trustScore, 0);
    const boundaryEvent = await prisma.trustScoreEvent.findUniqueOrThrow({ where: { eventKey: `manual-trust:${admin.id}:${boundaryId}` } });
    assert.equal(boundaryEvent.requestedDelta, -100);
    assert.equal(boundaryEvent.delta, -45);
  });

  await t.test('H12: pending checkout blocks account deactivation', async () => {
    const target = await user();
    const { service } = await market();
    const attempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `audit-${target.id}`, seekerId: target.id, providerId: provider.id, serviceId: service.id, providerIntentId: `pi_audit_${target.id}`, amount: 650, paymentMethod: 'gcash', expiresAt: new Date(Date.now() + 600000) } });
    const password = 'IndependentDeletion123!';
    await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await bcrypt.hash(password, 4) } });
    const session = await prisma.refreshToken.create({ data: { userId: target.id, token: `deletion-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) } });
    const result = await deleteOwnAccount(target.id, session.id, { confirmation: 'DELETE', method: 'password', password });
    assert.equal(result.deleted, false);
    if (!result.deleted) assert.ok(result.eligibility.blockers.some(item => item.type === 'paymentAttempts'));
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).isActive, true);
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status, 'PENDING');
  });

  await t.test('H12: moderation checks unstarted bookings under the account lock', async () => {
    const target = await user();
    await prisma.booking.create({ data: { seekerId: seeker.id, providerId: target.id, originType: 'DIRECT_LISTING', agreedAmount: 650, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID', status: 'PENDING_APPROVAL', started: false } });
    let blocked: any;
    await suspendUser({ user: { id: admin.id }, params: { id: target.id }, body: { reason: 'Independent moderation check', durationDays: 7 } } as never,
      response().res as never, error => { blocked = error; });
    assert.equal(blocked?.status, 409);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).moderationStatus, 'ACTIVE');
  });

  await t.test('H12: captured payment for a now-ineligible seeker requires refund, not a booking', async () => {
    const target = await user();
    const { service } = await market();
    const attempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `audit-${target.id}`, seekerId: target.id, providerId: provider.id, serviceId: service.id, providerIntentId: `pi_audit_${target.id}`, amount: 650, paymentMethod: 'gcash', expiresAt: new Date(Date.now() + 600000) } });
    // Model a prior moderation/deactivation commit before a delayed webhook.
    await prisma.user.update({ where: { id: target.id }, data: { isActive: false } });
    const captured = await finalizeSuccessfulPayment({ paymentIntentId: attempt.providerIntentId!, paymentId: `pay_audit_${target.id}`, amount: 650, currency: 'PHP', metadata: { servicehub_attempt_id: attempt.id, servicehub_seeker_id: target.id, servicehub_service_id: service.id, servicehub_offer_id: '', servicehub_expected_amount: '650.00', servicehub_payment_method: 'gcash' } });
    assert.equal(captured.created, false);
    assert.equal(captured.refundRequired, true);
    assert.equal(await prisma.booking.count({ where: { seekerId: target.id } }), 0);
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status, 'REFUND_REQUIRED');
  });

  await t.test('H12: UNDER_REVIEW cancellation on terminal cash booking blocks account finalization', async () => {
    const target = await user();
    const booking = await prisma.booking.create({ data: { seekerId: target.id, providerId: provider.id, originType: 'DIRECT_LISTING', agreedAmount: 650, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID', status: 'CANCELED' } });
    await prisma.cancellationRequest.create({ data: { bookingId: booking.id, requestedBy: target.id, responderId: provider.id, reason: 'Final closure still pending', status: 'UNDER_REVIEW', resolutionOutcome: 'IMMEDIATE_CANCEL_PENDING' } });
    const counts = await prisma.$transaction(tx => getUserActiveCaseCounts(tx, target.id));
    assert.equal(counts.cancellations, 1);
  });
});
