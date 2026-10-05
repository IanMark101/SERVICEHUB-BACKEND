import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { requestCancellation, respondToCancellationRequest, escalateCancellationRequest } from '../services/cancellation.service';
import { repairCompletedParticipantCancellationReport } from '../services/cancellation-report-finalization.service';
import { listModerationCases, startModerationReview } from '../services/admin-case-workspace.service';

test('participant approval closes an escalated cancellation and history uses closure time', async t => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const ids: string[] = [];
  let bookingId: string | undefined;
  t.after(async () => {
    if (bookingId) {
      await prisma.adminResolutionOperation.deleteMany({ where: { bookingId } });
      await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: ids } } });
      await prisma.cancellationRequest.deleteMany({ where: { bookingId } });
      await prisma.report.deleteMany({ where: { bookingId } });
      await prisma.message.deleteMany({ where: { bookingId } });
      await prisma.booking.delete({ where: { id: bookingId } });
    }
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });
  async function user(name: string, role = 'user') {
    const value = await prisma.user.create({ data: { name, role, email: `cancel-report-${name}-${suffix}@example.test`, passwordHash: 'test-only', phone: `${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`, location: 'Cordova, Cebu', emailVerified: true, verificationStatus: 'APPROVED' } });
    ids.push(value.id); return value;
  }
  const seeker = await user('Seeker'), provider = await user('Provider'), admin = await user('Admin', 'admin');
  const booking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, originType: 'DIRECT_LISTING', paymentMethod: 'On-site Cash', agreedAmount: 500, status: 'ONGOING', paymentStatus: 'UNPAID', started: true } });
  bookingId = booking.id;
  const created = await requestCancellation(booking.id, provider.id, 'I cannot finish this appointment.');
  assert.ok('request' in created && created.request);
  const request = created.request;
  await respondToCancellationRequest(request.id, seeker.id, false, 'Please continue the appointment.');
  await escalateCancellationRequest(request.id, provider.id);
  const reportId = (await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: request.id } })).reportId!;
  await startModerationReview('report', reportId, admin.id);
  await respondToCancellationRequest(request.id, seeker.id, true, 'I agree to cancel now.');
  const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
  assert.equal(report.status, 'RESOLVED'); assert.ok(report.resolvedAt);
  const settled = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(settled.status, 'CANCELED'); assert.equal(settled.paymentStatus, 'UNPAID');
  assert.equal(await prisma.paymentRefund.count({ where: { bookingId: booking.id } }), 0);
  const active = await listModerationCases({ page: 1, limit: 12, view: 'active', sort: 'attention', bookingId: booking.id });
  assert.equal(active.items.length, 0);
  const secondReport = await prisma.report.create({ data: { bookingId: booking.id, reporterId: seeker.id, reportedUserId: provider.id, reason: 'NO_SHOW', reportType: 'SAFETY', description: 'History ordering fixture only.', status: 'DISMISSED', createdAt: new Date(), resolvedAt: new Date(Date.now() - 86_400_000) } });
  await prisma.report.update({ where: { id: reportId }, data: { createdAt: new Date(Date.now() - 7 * 86_400_000) } });
  const history = await listModerationCases({ page: 1, limit: 12, view: 'history', sort: 'newest', bookingId: booking.id });
  assert.deepEqual(history.items.map(item => item.id), [reportId, secondReport.id]);
  await respondToCancellationRequest(request.id, seeker.id, true);
  assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: reportId, action: 'CANCELLATION_CASE_CLOSED_BY_PARTICIPANT' } }), 1);
  // Simulate only this fixture's pre-fix orphan and verify guarded, repeat-safe repair.
  await prisma.report.update({ where: { id: reportId }, data: { status: 'UNDER_REVIEW', resolvedAt: null } });
  assert.equal(await repairCompletedParticipantCancellationReport(request.id), true);
  assert.equal(await repairCompletedParticipantCancellationReport(request.id), false);
  await prisma.booking.update({ where: { id: booking.id }, data: { status: 'COMPLETED' } });
  await assert.rejects(repairCompletedParticipantCancellationReport(request.id), /no verified completed participant cancellation/);
});
