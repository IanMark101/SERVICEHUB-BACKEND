import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import app from '../app';
import { createSafetyReport } from '../services/safety-report.service';
import { resolveAdminReport } from '../services/admin-report.service';
import { getBookingMessagesForAdmin } from '../services/messages.service';
import { getModerationCase } from '../services/admin-case-workspace.service';
import { submitContentCase } from '../services/content-moderation-cases.service';
import { getWorkspaceCase } from '../services/content-workspace.service';
import { deleteUnusedListingPhoto, pruneUnusedListingPhotos } from '../services/listing-photos.service';

test('admin case review, conversation privacy, and original photo evidence', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/, 'Use SERVICEHUB_ADMIN_CASES_ONLY=1 npm run test:fresh-migrations (isolated database schema).');
  const tag = randomUUID();
  const makeUser = (name: string, role = 'user') => prisma.user.create({ data: { name, role, email: `${name}-${tag}@example.test`, passwordHash: 'test-only', phone: '', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED' } });
  const [admin, seeker, provider] = await Promise.all([makeUser('admin', 'admin'), makeUser('seeker'), makeUser('provider')]);
  const category = await prisma.category.create({ data: { name: `Admin test ${tag}` } });
  const listing = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: 'Laptop repair', titleNormalized: 'laptop repair', description: 'Repair laptops after checking the issue and agreeing on the price.', price: 500, estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: false }, status: 'ACTIVE', isAvailable: true } });
  const booking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: listing.id, agreedAmount: 500, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID', started: true, status: 'ONGOING' } });
  t.after(async () => { await prisma.$disconnect(); });

  await t.test('a warning closes a safety case without settling money; duplicate decisions do not repeat notifications', async () => {
    const report = await createSafetyReport({ bookingId: booking.id, reporterId: seeker.id, reason: 'INAPPROPRIATE_BEHAVIOR', description: 'The provider used abusive language during this booking.' });
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'DISPUTED');
    await resolveAdminReport(report.id, admin.id, 'resolve_safety', 'The conversation confirms abusive language. A warning is appropriate.', 'warn');
    const state = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    assert.equal(state.status, 'ONGOING'); assert.equal(state.paymentStatus, 'UNPAID');
    const notifications = await prisma.notification.count({ where: { userId: provider.id } });
    await resolveAdminReport(report.id, admin.id, 'resolve_safety', 'The conversation confirms abusive language. A warning is appropriate.', 'warn');
    assert.equal(await prisma.notification.count({ where: { userId: provider.id } }), notifications);
  });

  await t.test('invalid penalties reject before claiming a decision; a claimed retry preserves a later ban', async () => {
    const report = await createSafetyReport({ bookingId: booking.id, reporterId: seeker.id, reason: 'SCAM_OR_FRAUD', description: 'The provider requested a suspicious payment after work started.' });
    await prisma.user.update({ where: { id: provider.id }, data: { moderationStatus: 'BANNED' } });
    await assert.rejects(resolveAdminReport(report.id, admin.id, 'resolve_safety', 'Evidence supports this report.', 'suspend'), (e: any) => e.code === 'INVALID_REPORT_PENALTY');
    assert.equal(await prisma.adminResolutionOperation.count({ where: { caseId: report.id } }), 0);
    assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status, 'PENDING');
    await prisma.adminResolutionOperation.create({ data: { operationKey: `REPORT:${report.id}`, caseType: 'REPORT', caseId: report.id, bookingId: booking.id, requestedByAdminId: admin.id, requestedOutcome: 'resolve_safety', requestedPenalty: 'suspend', notes: 'Evidence supports this report.', status: 'FAILED_RETRYABLE', stage: 'DECISION_READY' } });
    const result = await resolveAdminReport(report.id, admin.id, 'resolve_safety', 'Evidence supports this report.', 'suspend') as { appliedPenalty: string };
    assert.equal(result.appliedPenalty, 'none');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).moderationStatus, 'BANNED');
    assert.match((await getModerationCase('report', report.id)).penaltyNote || '', /restrictions were preserved/);
    await prisma.user.update({ where: { id: provider.id }, data: { moderationStatus: 'ACTIVE' } });
  });

  await t.test('a deactivated participant cannot be reactivated by a case penalty', async () => {
    const report = await createSafetyReport({ bookingId: booking.id, reporterId: seeker.id, reason: 'NO_SHOW', description: 'The provider did not return for the agreed follow-up visit.' });
    await prisma.user.update({ where: { id: provider.id }, data: { isActive: false } });
    await assert.rejects(resolveAdminReport(report.id, admin.id, 'resolve_safety', 'Reviewed the missed visit.', 'ban'), (e: any) => e.code === 'INVALID_REPORT_PENALTY');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).isActive, false);
    await resolveAdminReport(report.id, admin.id, 'dismiss', 'No evidence established a violation.');
    await prisma.user.update({ where: { id: provider.id }, data: { isActive: true } });
  });

  await t.test('chat pages are complete and stable even when timestamps tie, and cannot cross bookings', async () => {
    const at = new Date('2026-10-14T01:00:00Z');
    await prisma.message.createMany({ data: Array.from({ length: 121 }, (_, index) => ({ id: `admin-chat-${tag}-${String(index).padStart(3, '0')}`, bookingId: booking.id, senderId: index % 2 ? seeker.id : provider.id, receiverId: index % 2 ? provider.id : seeker.id, content: `Message ${index}`, createdAt: at })) });
    const seen: string[] = []; let before: string | undefined;
    do {
      const page = await getBookingMessagesForAdmin(booking.id, { before });
      assert.ok(page.messages.length <= 50); assert.equal(page.messageCount, 121);
      seen.unshift(...page.messages.map(message => message.id));
      before = page.pagination.nextBefore || undefined;
    } while (before);
    assert.equal(seen.length, 121); assert.equal(new Set(seen).size, 121);
    assert.deepEqual(seen, [...seen].sort());
    const other = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: listing.id, status: 'CANCELED', paymentStatus: 'UNPAID', paymentMethod: 'On-site Cash', agreedAmount: 500 } });
    await assert.rejects(getBookingMessagesForAdmin(other.id, { before: seen[0] }), (e: any) => e.code === 'INVALID_MESSAGE_CURSOR');
  });

  await t.test('conversation access requires an admin session and records each viewed page', async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/bookings/${booking.id}/messages`;
      assert.equal((await fetch(url)).status, 401);
      const token = async (user: typeof admin) => {
        const session = await prisma.refreshToken.create({ data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
        return jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1m' });
      };
      assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${await token(seeker)}` } })).status, 403);
      const headers = { Authorization: `Bearer ${await token(admin)}` };
      const response = await fetch(`${url}?limit=20`, { headers }); assert.equal(response.status, 200);
      const body = await response.json() as { data: { messages: unknown[] } }; assert.equal(body.data.messages.length, 20);
      assert.equal(await prisma.adminAuditLog.count({ where: { action: 'BOOKING_MESSAGES_VIEWED', resourceId: booking.id, actorId: admin.id } }), 1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  await t.test('photos captured in a report remain evidence after the listing changes', async () => {
    const photo = await prisma.listingPhoto.create({ data: { ownerId: provider.id, publicId: `fixture-only-${tag}`, url: 'https://example.test/original-photo.jpg', width: 1000, height: 700, createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000) } });
    await prisma.serviceListingPhoto.create({ data: { serviceId: listing.id, photoId: photo.id, position: 0 } });
    const report = await submitContentCase(seeker.id, { caseType: 'REPORT', contentType: 'SERVICE_LISTING', resourceId: listing.id, reason: 'This photo misrepresents the repair service. Please review it.' });
    await prisma.serviceListingPhoto.deleteMany({ where: { serviceId: listing.id } });
    const detail = await getWorkspaceCase(report.id);
    assert.equal((detail.contentSnapshot as any).photos[0].id, photo.id);
    assert.deepEqual(detail.content?.photos, []);
    await assert.rejects(deleteUnusedListingPhoto(provider.id, photo.id), /retained as evidence/);
    await pruneUnusedListingPhotos();
    assert.ok(await prisma.listingPhoto.findUnique({ where: { id: photo.id } }));
  });
});
