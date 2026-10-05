import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { resolveAdminReport } from '../services/admin-report.service';
import { resolveCompletionEscalation } from '../services/completion-escalation.service';
import { createDirectRequest } from '../services/bookings/direct-bookings.service';

test('independent settlement recovery and report-account coordination', async (t) => {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^audit_20260924_[a-f0-9]{32}$/);
  t.after(() => prisma.$disconnect());
  const user = (role = 'user') => prisma.user.create({ data: {
    name: 'Recovery verification', email: `${randomUUID()}@example.test`, phone: randomUUID(), location: 'Cordova',
    passwordHash: 'test-only', role, emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const admin = await user('admin');
  const seeker = await user();
  const provider = await user();
  const seeded = async (kind: 'REPORT' | 'COMPLETION_ESCALATION', release: boolean, penalty = 'none') => {
    const booking = await prisma.booking.create({ data: {
      seekerId: seeker.id, providerId: provider.id, originType: 'DIRECT_LISTING', paymentMethod: 'GCash',
      agreedAmount: 650, started: true, status: release ? 'COMPLETED' : 'CANCELED', paymentStatus: release ? 'RELEASED' : 'REFUNDED',
    } });
    if (release) await prisma.completedService.create({ data: {
      bookingId: booking.id, seekerId: seeker.id, providerId: provider.id, finalPrice: 650, paymentStatus: 'RELEASED',
    } });
    else await prisma.paymentRefund.create({ data: {
      bookingId: booking.id, paymentId: `pay_${randomUUID()}`, paymongoRefundId: `ref_${randomUUID()}`,
      amount: 650, status: 'SUCCEEDED', reason: 'others', requestedById: admin.id,
    } });
    const caseRow = kind === 'REPORT'
      ? await prisma.report.create({ data: { bookingId: booking.id, reporterId: seeker.id, reportedUserId: provider.id,
        reason: 'INCOMPLETE_SERVICE', description: 'Post-settlement interruption', reportType: 'COMPLETION_DISPUTE', status: 'UNDER_REVIEW', adminId: admin.id } })
      : await prisma.completionEscalation.create({ data: { bookingId: booking.id, requestedBy: provider.id,
        reason: 'Post-settlement interruption', status: 'UNDER_REVIEW', adminId: admin.id } });
    const outcome = release ? 'release_provider_and_complete' : kind === 'REPORT' ? 'cancel_booking' : 'refund_seeker';
    const operation = await prisma.adminResolutionOperation.create({ data: {
      operationKey: `${kind}:${caseRow.id}`, caseType: kind, caseId: caseRow.id, bookingId: booking.id,
      requestedByAdminId: admin.id, requestedOutcome: outcome, requestedPenalty: penalty, notes: 'Independent recovery',
      stage: 'FINANCIAL_EFFECT_RESERVED', status: 'FAILED_RETRYABLE',
    } });
    return { booking, caseRow, operation };
  };
  for (const kind of ['REPORT', 'COMPLETION_ESCALATION'] as const) {
    for (const release of [true, false]) {
      await t.test(`${kind} online ${release ? 'release' : 'refund'} concurrent recovery finalizes once`, async () => {
        const { booking, caseRow, operation } = await seeded(kind, release);
        const resolve = () => kind === 'REPORT'
          ? resolveAdminReport(caseRow.id, admin.id, release ? 'release_provider_and_complete' : 'cancel_booking', 'Independent recovery', 'none')
          : resolveCompletionEscalation({ escalationId: caseRow.id, adminId: admin.id,
            action: release ? 'release_provider_and_complete' : 'refund_seeker', resolution: 'Independent recovery' });
        const results = await Promise.all([resolve(), resolve()]);
        assert.deepEqual(results[0], results[1]);
        assert.equal((await prisma.adminResolutionOperation.findUniqueOrThrow({ where: { id: operation.id } })).stage, 'CASE_FINALIZED');
        assert.equal(await prisma.completedService.count({ where: { bookingId: booking.id } }), release ? 1 : 0);
        assert.equal(await prisma.paymentRefund.count({ where: { bookingId: booking.id } }), release ? 0 : 1);
        assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: caseRow.id } }), 1);
      });
    }
  }

  for (const penalty of ['suspend', 'ban'] as const) {
    await t.test(`report ${penalty} holding the account lock rejects a concurrent new cash booking`, async () => {
      const { caseRow, operation } = await seeded('REPORT', true, penalty);
      const category = await prisma.category.create({ data: { name: `Moderation first ${randomUUID()}` } });
      const title = `Moderation first ${randomUUID()}`;
      const service = await prisma.service.create({ data: {
        providerId: provider.id, categoryId: category.id, title, titleNormalized: title.toLowerCase(),
        description: 'Independent reverse-order fixture', price: 650, estimatedDurationMins: 30,
        status: 'ACTIVE', isAvailable: true, paymentMethods: { cash: true },
      } });
      const otherSeeker = await user();
      let reached!: () => void;
      let release!: () => void;
      const read = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const originalTransaction = prisma.$transaction.bind(prisma);
      prisma.$transaction = ((work: any, options: any) => typeof work !== 'function'
        ? originalTransaction(work, options)
        : originalTransaction((tx: any) => work(new Proxy(tx, { get(target, key) {
          if (key !== 'user') return Reflect.get(target, key);
          return new Proxy(target.user, { get(delegate, method) {
            if (method !== 'update') return Reflect.get(delegate, method);
            return async (args: any) => {
              if (args.where?.id === provider.id && args.data?.moderationStatus) { reached(); await gate; }
              return delegate.update(args);
            };
          } });
        } })), { ...options, timeout: 60000 })) as typeof prisma.$transaction;
      const moderation = resolveAdminReport(caseRow.id, admin.id, 'release_provider_and_complete', 'Independent recovery', penalty);
      const moderationResult = moderation.then(value => ({ value }), error => ({ error }));
      let bookingResult: Promise<{ value: unknown } | { error: any }> | undefined;
      const guard = setTimeout(release, 20000);
      try {
        await Promise.race([read, moderation.then(() => { throw new Error('Moderation did not reach barrier'); })]);
        bookingResult = createDirectRequest({ seekerId: otherSeeker.id, providerId: provider.id, serviceId: service.id })
          .then(value => ({ value }), error => ({ error }));
        // Give the real booking transaction time to contend with the held lock.
        await new Promise(resolve => setTimeout(resolve, 1500));
      } finally {
        release();
        clearTimeout(guard);
      }
      try {
        assert.ok('value' in await moderationResult);
        assert.ok(bookingResult);
        const booking = await bookingResult;
        assert.ok('error' in booking, 'Booking must recheck eligibility after moderation commits');
        assert.equal(booking.error.status, 409);
        assert.equal(await prisma.booking.count({ where: { serviceId: service.id } }), 0);
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).moderationStatus,
          penalty === 'ban' ? 'BANNED' : 'SUSPENDED');
        assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: caseRow.id } })).status, 'RESOLVED');
        assert.equal((await prisma.adminResolutionOperation.findUniqueOrThrow({ where: { id: operation.id } })).stage, 'CASE_FINALIZED');
        assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: caseRow.id } }), 1);
      } finally {
        prisma.$transaction = originalTransaction;
        await prisma.user.update({ where: { id: provider.id }, data: { moderationStatus: 'ACTIVE', suspendedUntil: null } });
      }
    });
  }

  await t.test('report suspension must coordinate with a cash booking holding the participant lock', async () => {
    const { caseRow } = await seeded('REPORT', true, 'suspend');
    const category = await prisma.category.create({ data: { name: `Coordination ${randomUUID()}` } });
    const title = `Coordination ${randomUUID()}`;
    const service = await prisma.service.create({ data: {
      providerId: provider.id, categoryId: category.id, title, titleNormalized: title.toLowerCase(), description: 'Independent race fixture',
      price: 650, estimatedDurationMins: 30, status: 'ACTIVE', isAvailable: true, paymentMethods: { cash: true },
    } });
    const otherSeeker = await user();
    let reached!: () => void;
    let release!: () => void;
    const read = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalTransaction = prisma.$transaction.bind(prisma);
    // Hold the real eligibility snapshot AFTER the account locks are acquired.
    prisma.$transaction = ((work: any, options: any) => typeof work !== 'function'
      ? originalTransaction(work, options)
      : originalTransaction((tx: any) => work(new Proxy(tx, { get(target, key) {
        if (key !== 'user') return Reflect.get(target, key);
        return new Proxy(target.user, { get(delegate, method) {
          if (method !== 'findMany') return Reflect.get(delegate, method);
          return async (args: any) => {
            const rows = await delegate.findMany(args);
            if (args.where?.id?.in?.includes(otherSeeker.id)) { reached(); await gate; }
            return rows;
          };
        } });
      } })), { ...options, timeout: 60000 })) as typeof prisma.$transaction;
    const booking = createDirectRequest({ seekerId: otherSeeker.id, providerId: provider.id, serviceId: service.id });
    const bookingResult = booking.then(value => ({ value }), error => ({ error }));
    let moderationResult: Promise<unknown> | undefined;
    try {
      await read;
      // A correct lock participant waits until booking commits, then rejects
      // suspension because an unstarted booking exists. The timer only releases
      // the test barrier, not production timing or business behavior.
      const timer = setTimeout(release, 15000);
      moderationResult = resolveAdminReport(caseRow.id, admin.id, 'release_provider_and_complete', 'Independent recovery', 'suspend')
        .then(value => ({ value }), error => ({ error }));
      await moderationResult;
      clearTimeout(timer);
    } finally {
      release();
      prisma.$transaction = originalTransaction;
    }
    const bookingOutcome = await bookingResult;
    assert.ok('value' in bookingOutcome, 'The booking already holding the provider lock must commit first');
    assert.ok(moderationResult);
    const moderationOutcome = await moderationResult;
    assert.ok(typeof moderationOutcome === 'object' && moderationOutcome !== null && 'error' in moderationOutcome,
      'Report suspension must reject after the new unstarted booking commits');
    assert.equal((moderationOutcome.error as { status?: number }).status, 409);
    const target = await prisma.user.findUniqueOrThrow({ where: { id: provider.id } });
    const active = await prisma.booking.count({ where: { serviceId: service.id, started: false, status: 'PENDING_APPROVAL' } });
    assert.equal(target.moderationStatus, 'ACTIVE');
    assert.equal(active, 1);
  });
});
