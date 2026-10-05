import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { loginUser, logoutUser, resetPassword } from '../services/auth/authentication.service';
import { changeUserPassword } from '../services/auth/profile.service';
import { requireAuth } from '../middlewares/auth.middleware';
import { finalizeSuccessfulPayment } from '../services/payment-attempt.service';
import { deleteOwnAccount } from '../services/account-deletion.service';
import { createDirectRequest } from '../services/bookings/direct-bookings.service';

// Verification only: real services, disposable migrated schema, no external APIs.
test('independent post-remediation boundary checks', async (t) => {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^audit_20260924_[a-f0-9]{32}$/);
  t.after(() => prisma.$disconnect());
  const oldPassword = 'AuditOldPassword123!';
  const newPassword = 'AuditNewPassword456!';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const passwordHash = await bcrypt.hash(oldPassword, 4);
  const user = (role = 'user') => prisma.user.create({ data: {
    name: 'Independent regression', email: `${randomUUID()}@example.test`, phone: randomUUID(),
    location: 'Cordova', role, passwordHash, emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const response = () => {
    const result = { code: 200, body: undefined as unknown };
    return { result, res: { status(code: number) { result.code = code; return this; }, json(body: unknown) { result.body = body; return this; } } };
  };
  const authorized = async (token: string) => {
    let allowed = false;
    await requireAuth({ headers: { authorization: `Bearer ${token}` } } as never, response().res as never,
      error => { if (error) throw error; allowed = true; });
    return allowed;
  };
  const admin = await user('admin');
  const category = await prisma.category.create({ data: { name: `Independent ${randomUUID()}` } });
  const market = async () => {
    const seeker = await user();
    const provider = await user();
    const title = `Independent ${randomUUID()}`;
    const service = await prisma.service.create({ data: {
      providerId: provider.id, categoryId: category.id, title, titleNormalized: title.toLowerCase(),
      description: 'Disposable regression fixture', price: 650, estimatedDurationMins: 30,
      status: 'ACTIVE', isAvailable: true, queueLimit: 5, paymentMethods: { cash: true, gcash: true },
    } });
    return { seeker, provider, service };
  };
  const checkout = async (fixture: Awaited<ReturnType<typeof market>>) => {
    const attempt = await prisma.paymentAttempt.create({ data: {
      idempotencyKey: randomUUID(), seekerId: fixture.seeker.id, providerId: fixture.provider.id,
      serviceId: fixture.service.id, providerIntentId: `pi_${randomUUID()}`, amount: 650,
      paymentMethod: 'gcash', expiresAt: new Date(Date.now() + 600000),
    } });
    const capture = () => finalizeSuccessfulPayment({
      paymentIntentId: attempt.providerIntentId!, paymentId: `pay_${attempt.id}`, amount: 650, currency: 'PHP',
      metadata: { servicehub_attempt_id: attempt.id, servicehub_seeker_id: fixture.seeker.id,
        servicehub_service_id: fixture.service.id, servicehub_offer_id: '', servicehub_expected_amount: '650.00', servicehub_payment_method: 'gcash' },
    });
    return { attempt, capture };
  };

  await t.test('logout leaves another real browser session authorized', async () => {
    const target = await user();
    const first = await loginUser({ email: target.email, password: oldPassword });
    const second = await loginUser({ email: target.email, password: oldPassword });
    await logoutUser(first.tokens.refreshToken);
    assert.equal(await authorized(first.tokens.accessToken), false);
    assert.equal(await authorized(second.tokens.accessToken), true);
  });

  for (const mode of ['change', 'reset'] as const) {
    await t.test(`${mode} revokes both established sessions and accepts only the new password`, async () => {
      const target = await user();
      const first = await loginUser({ email: target.email, password: oldPassword });
      const second = await loginUser({ email: target.email, password: oldPassword });
      if (mode === 'change') await changeUserPassword(target.id, oldPassword, newPassword);
      else {
        const token = randomUUID();
        await prisma.passwordResetToken.create({ data: { userId: target.id, token: hash(token), expiresAt: new Date(Date.now() + 60000) } });
        await resetPassword(token, newPassword);
      }
      assert.equal(await authorized(first.tokens.accessToken), false);
      assert.equal(await authorized(second.tokens.accessToken), false);
      await assert.rejects(loginUser({ email: target.email, password: oldPassword }), /Invalid credentials/);
      assert.equal(await authorized((await loginUser({ email: target.email, password: newPassword })).tokens.accessToken), true);
    });

    await t.test(`${mode} must not allow an in-flight old-password login to create a surviving session`, async () => {
      const target = await user();
      const resetToken = randomUUID();
      if (mode === 'reset') await prisma.passwordResetToken.create({ data: {
        userId: target.id, token: hash(resetToken), expiresAt: new Date(Date.now() + 60000),
      } });
      // Pause only the login's snapshot read; change/reset continue using real DB.
      const original = prisma.user.findUnique.bind(prisma.user);
      let reached!: () => void;
      let resume!: () => void;
      const read = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { resume = resolve; });
      prisma.user.findUnique = (async (args: any) => {
        const row = await original(args);
        if (args.where?.email === target.email) { reached(); await gate; }
        return row;
      }) as typeof prisma.user.findUnique;
      const pending = loginUser({ email: target.email, password: oldPassword });
      // Attach a rejection handler immediately; no unhandled rejection on fixed code.
      const outcome = pending.then(value => ({ value }), error => ({ error }));
      try {
        await read;
        if (mode === 'change') await changeUserPassword(target.id, oldPassword, newPassword);
        else await resetPassword(resetToken, newPassword);
        assert.equal(await prisma.refreshToken.count({ where: { userId: target.id } }), 0);
      } finally {
        prisma.user.findUnique = original;
        resume();
      }
      const result = await outcome;
      assert.ok('error' in result, `${mode}: stale credential snapshot minted a session AFTER revocation committed`);
      assert.equal((result.error as { status?: number }).status, 401);
      assert.equal(await prisma.refreshToken.count({ where: { userId: target.id } }), 0);
    });
  }

  await t.test('active-offer DB index rejects all active duplicates while retaining inactive history', async () => {
    const { seeker, provider, service } = await market();
    const request = await prisma.serviceRequest.create({ data: {
      seekerId: seeker.id, categoryId: category.id, title: 'Constraint test', description: 'History remains valid', urgency: 'medium', budgetMin: 500, budgetMax: 700,
    } });
    const data = { requestId: request.id, providerId: provider.id, serviceId: service.id, offeredPrice: 650, estimatedDuration: 30 };
    const active = await prisma.offer.create({ data });
    for (const status of ['PENDING', 'PENDING_PAYMENT', 'ACCEPTED'] as const) {
      await assert.rejects(prisma.offer.create({ data: { ...data, status } }), (error: any) => error.code === 'P2002');
    }
    await prisma.offer.create({ data: { ...data, status: 'REJECTED' } });
    await prisma.offer.create({ data: { ...data, status: 'WITHDRAWN' } });
    await prisma.offer.update({ where: { id: active.id }, data: { status: 'WITHDRAWN' } });
    await prisma.offer.create({ data });
    assert.equal(await prisma.offer.count({ where: { requestId: request.id } }), 4);
  });

  await t.test('eligible duplicate captures create one booking and queue with the immutable attempt price', async () => {
    const fixture = await market();
    const { attempt, capture } = await checkout(fixture);
    await prisma.service.update({ where: { id: fixture.service.id }, data: { price: 900 } });
    const results = await Promise.all([capture(), capture()]);
    assert.equal(results.filter(result => result.created).length, 1);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { paymentAttemptId: attempt.id } });
    assert.equal(Number(booking.agreedAmount), 650);
    assert.equal(await prisma.queue.count({ where: { bookingId: booking.id } }), 1);
  });

  for (const side of ['seeker', 'provider'] as const) {
    await t.test(`inactive ${side}: duplicate capture remains refund-required without booking or queue`, async () => {
      const fixture = await market();
      const { attempt, capture } = await checkout(fixture);
      await prisma.user.update({ where: { id: fixture[side].id }, data: { isActive: false } });
      const results = await Promise.all([capture(), capture()]);
      assert.ok(results.every(result => !result.created && result.refundRequired));
      assert.equal(await prisma.booking.count({ where: { paymentAttemptId: attempt.id } }), 0);
      assert.equal(await prisma.queue.count({ where: { serviceId: fixture.service.id } }), 0);
      const persisted = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(persisted.status, 'REFUND_REQUIRED');
      assert.equal(persisted.failureReason, 'PARTICIPANT_INELIGIBLE_AFTER_CAPTURE');
      assert.equal(persisted.providerPaymentId, `pay_${attempt.id}`);
    });
    await t.test(`pending checkout blocks ${side} deletion even when capture races it`, async () => {
      const fixture = await market();
      const { capture } = await checkout(fixture);
      const target = fixture[side];
      const session = await prisma.refreshToken.create({ data: { userId: target.id, token: hash(randomUUID()), expiresAt: new Date(Date.now() + 60_000) } });
      const [deletion] = await Promise.all([
        deleteOwnAccount(target.id, session.id, { confirmation: 'DELETE', method: 'password', password: oldPassword }), capture(),
      ]);
      assert.equal(deletion.deleted, false);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).isActive, true);
    });
  }

  await t.test('cash booking is rejected after seeker deactivation', async () => {
    const fixture = await market();
    await prisma.user.update({ where: { id: fixture.seeker.id }, data: { isActive: false } });
    await assert.rejects(createDirectRequest({ seekerId: fixture.seeker.id, providerId: fixture.provider.id, serviceId: fixture.service.id }), /eligible/);
    assert.equal(await prisma.booking.count({ where: { seekerId: fixture.seeker.id } }), 0);
  });
});
