import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { resolveAdminReport } from '../services/admin-report.service';
import { resolveCompletionEscalation } from '../services/completion-escalation.service';
import { markAdminResolutionStage } from '../services/admin-resolution-operation.service';
import { providerStartJob } from '../services/bookings/provider-operations.service';
import { requestCancellation } from '../services/cancellation.service';

// Desired-behavior regression tests for independently reproduced boundaries.
test('independent C1-C3/H1-H5 recovery boundary verification', async (t) => {
  assert.match(new URL(process.env.DATABASE_URL!).searchParams.get('schema') || '', /^audit_20260924_[a-f0-9]{32}$/);
  t.after(() => prisma.$disconnect());
  const makeUser = (name: string, role = 'user') => prisma.user.create({ data: {
    name, role, email: `${name}@independent.example.test`, passwordHash: 'test-only',
    phone: name, location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const admin = await makeUser('independent-admin', 'admin');
  const seeker = await makeUser('independent-seeker');
  const provider = await makeUser('independent-provider');
  const terminal = async (release: boolean) => {
    const booking = await prisma.booking.create({ data: {
      seekerId: seeker.id, providerId: provider.id, originType: 'DIRECT_LISTING',
      paymentMethod: 'On-site Cash', agreedAmount: 650, started: true,
      status: release ? 'COMPLETED' : 'CANCELED', paymentStatus: release ? 'CASH_CONFIRMED' : 'UNPAID',
      statusBeforeDispute: null,
    } });
    if (release) await prisma.completedService.create({ data: { bookingId: booking.id, seekerId: seeker.id, providerId: provider.id, finalPrice: 650, paymentStatus: 'CASH_CONFIRMED' } });
    return booking;
  };

  await t.test('gap 1: RESERVED release recovers after settlement clears statusBeforeDispute', async () => {
    const booking = await terminal(true);
    const report = await prisma.report.create({ data: { bookingId: booking.id, reporterId: seeker.id, reportedUserId: provider.id, reason: 'INCOMPLETE_SERVICE', description: 'Process stopped after settlement before stage update.', reportType: 'COMPLETION_DISPUTE', status: 'UNDER_REVIEW', adminId: admin.id } });
    const operation = await prisma.adminResolutionOperation.create({ data: { operationKey: `REPORT:${report.id}`, caseType: 'REPORT', caseId: report.id, bookingId: booking.id, requestedByAdminId: admin.id, requestedOutcome: 'release_provider_and_complete', requestedPenalty: 'none', notes: 'Retry', stage: 'FINANCIAL_EFFECT_RESERVED', status: 'FAILED_RETRYABLE' } });
    const first = await resolveAdminReport(report.id, admin.id, 'release_provider_and_complete', 'Retry', 'none');
    const second = await resolveAdminReport(report.id, admin.id, 'release_provider_and_complete', 'Retry', 'none');
    assert.deepEqual(second, first);
    assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status, 'RESOLVED');
    assert.equal(await prisma.completedService.count({ where: { bookingId: booking.id } }), 1);
    assert.equal((await prisma.adminResolutionOperation.findUniqueOrThrow({ where: { id: operation.id } })).stage, 'CASE_FINALIZED');
  });

  for (const action of ['release_provider_and_complete', 'refund_seeker'] as const) {
    await t.test(`gap 2: RESERVED ${action} recovers the established terminal outcome`, async () => {
      const booking = await terminal(action === 'release_provider_and_complete');
      const escalation = await prisma.completionEscalation.create({ data: { bookingId: booking.id, requestedBy: provider.id, reason: 'Process stopped after settlement.', status: 'UNDER_REVIEW', adminId: admin.id } });
      const operation = await prisma.adminResolutionOperation.create({ data: { operationKey: `COMPLETION_ESCALATION:${escalation.id}`, caseType: 'COMPLETION_ESCALATION', caseId: escalation.id, bookingId: booking.id, requestedByAdminId: admin.id, requestedOutcome: action, notes: 'Retry', stage: 'FINANCIAL_EFFECT_RESERVED', status: 'FAILED_RETRYABLE' } });
      const input = { escalationId: escalation.id, adminId: admin.id, action, resolution: 'Retry' };
      const first = await resolveCompletionEscalation(input);
      const second = await resolveCompletionEscalation(input);
      assert.deepEqual(second, first);
      assert.equal((await prisma.completionEscalation.findUniqueOrThrow({ where: { id: escalation.id } })).status, 'RESOLVED');
      assert.equal((await prisma.adminResolutionOperation.findUniqueOrThrow({ where: { id: operation.id } })).stage, 'CASE_FINALIZED');
      assert.equal(await prisma.completedService.count({ where: { bookingId: booking.id } }), action === 'release_provider_and_complete' ? 1 : 0);
    });
  }

  await t.test('gap 3: a nonterminal operation cannot move backward', async () => {
    const booking = await terminal(false);
    const operation = await prisma.adminResolutionOperation.create({ data: { operationKey: 'REPORT:independent-stage', caseType: 'REPORT', caseId: 'independent-stage', bookingId: booking.id, requestedByAdminId: admin.id, requestedOutcome: 'cancel_booking', notes: 'Late-worker verification', stage: 'FINANCIAL_EFFECT_RESERVED' } });
    await markAdminResolutionStage(operation.id, 'DECISION_READY');
    assert.equal((await prisma.adminResolutionOperation.findUniqueOrThrow({ where: { id: operation.id } })).stage, 'FINANCIAL_EFFECT_RESERVED');
  });

  await t.test('gap 5: cancellation races a genuinely eligible Start on a free provider', async () => {
    const booking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, originType: 'DIRECT_LISTING', paymentMethod: 'On-site Cash', agreedAmount: 650, started: false, status: 'ACCEPTED', paymentStatus: 'UNPAID' } });
    assert.equal(await prisma.booking.count({ where: { providerId: provider.id, status: 'ONGOING' } }), 0);
    const outcomes = await Promise.allSettled([providerStartJob(booking.id, provider.id), requestCancellation(booking.id, seeker.id, 'Independent valid start/cancel race')]);
    assert.ok(outcomes.some(result => result.status === 'fulfilled'));
    const current = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    if (current.status === 'CANCELED') assert.equal(current.started, false);
    else {
      assert.equal(current.status, 'ONGOING');
      assert.equal(current.started, true);
      assert.equal(await prisma.cancellationRequest.count({ where: { bookingId: booking.id, status: 'PENDING' } }), 1);
    }
  });
});
