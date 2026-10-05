import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import app from '../app';
import { submitContentCase } from '../services/content-moderation-cases.service';
import { changeWorkspaceContent, decideWorkspaceCase, getWorkspaceCase, listWorkspaceContent, listWorkspaceCases, readPublicContent } from '../services/content-workspace.service';
import { getAccountDeletionEligibility } from '../services/account-deletion.service';

test('unified public content lifecycle, owner consequences, recovery, and authorization', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/, 'Run this suite through SERVICEHUB_CONTENT_ONLY=1 npm run test:fresh-migrations; it requires an isolated schema.');
  const tag = randomUUID();
  const user = (name: string, role = 'user') => prisma.user.create({ data: { name, email: `${name.replaceAll(' ', '-')}-${tag}@example.test`, passwordHash: 'fixture-only', phone: '', location: 'Cordova', role, emailVerified: true, verificationStatus: 'APPROVED' } });
  const [admin, owner, reporter] = await Promise.all([user('Content admin', 'admin'), user('Content owner'), user('Content reporter')]);
  const category = await prisma.category.create({ data: { name: `Content fixture ${tag}` } });
  const listing = await prisma.service.create({ data: { providerId: owner.id, categoryId: category.id, title: 'Local faucet repair', titleNormalized: 'local faucet repair', description: 'Repair leaking faucets with clear agreed pricing and scheduling.', price: 500, estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: false }, status: 'ACTIVE', isAvailable: true, publishedAt: new Date() } });
  const request = await prisma.serviceRequest.create({ data: { seekerId: reporter.id, categoryId: category.id, title: 'Repair kitchen faucet', description: 'The kitchen faucet needs careful repair this week.', budgetMin: 500, budgetMax: 500, urgency: 'Flexible' } });
  const reportListing = () => submitContentCase(reporter.id, { caseType: 'REPORT', contentType: 'SERVICE_LISTING', resourceId: listing.id, reason: 'Please review whether this description is misleading.' });
  const version = async (type: 'SERVICE_LISTING' | 'SERVICE_REQUEST', id: string) => {
    const item = await readPublicContent(prisma, type, id); assert.ok(item);
    return { expectedUpdatedAt: item.updatedAt.toISOString(), expectedOwnerStatus: item.owner.moderationStatus };
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/content`;
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });

  const first = await reportListing();
  await t.test('reports save original content and target its owner without automatically removing or banning', async () => {
    assert.equal(first.contentOwnerId, owner.id);
    assert.equal((first.contentSnapshot as any).title, listing.title);
    assert.equal((first.contentSnapshot as any).email, undefined);
    const detail = await getWorkspaceCase(first.id);
    assert.equal(detail.content?.owner.id, owner.id); assert.ok(detail.allowedDecisions.includes('REMOVE'));
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: listing.id } })).status, 'ACTIVE');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).moderationStatus, 'ACTIVE');
    assert.equal((await prisma.notification.findFirstOrThrow({ where: { userId: admin.id, title: 'Public Content Report' } })).link, `/admin/content-cases?caseId=${first.id}`);
    assert.equal((await getAccountDeletionEligibility(owner.id)).counts.contentCases, 1);
  });

  await t.test('admin APIs require a live admin session and reject old explanation-only mutations', async () => {
    const [as, rs] = await Promise.all([admin, reporter].map(u => prisma.refreshToken.create({ data: { userId: u.id, token: randomUUID(), expiresAt: new Date(Date.now() + 300000) } })));
    const headers = (u: typeof admin, sid: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: u.id, sid, role: u.role }, env.JWT_ACCESS_SECRET, { expiresIn: '5m' })}` });
    assert.equal((await fetch(`${base}/cases/${first.id}`)).status, 401);
    assert.equal((await fetch(`${base}/cases/${first.id}`, { headers: headers(reporter, rs.id) })).status, 403);
    const detail = await fetch(`${base}/cases/${first.id}`, { headers: headers(admin, as.id) }); assert.equal(detail.status, 200);
    assert.equal(JSON.stringify(await detail.json()).includes('passwordHash'), false);
    assert.equal((await fetch(`${base}/cases/${first.id}`, { method: 'PATCH', headers: headers(admin, as.id), body: JSON.stringify({ resolution: 'Explanation with no actual outcome.' }) })).status, 400);
  });

  await t.test('removal and warning commit together, notify both parties, and retry only once', async () => {
    const input = { decision: 'REMOVE' as const, penalty: 'warn' as const, resolution: 'The advertised price is misleading. Remove this content and warn its owner.', suspensionDays: 7, ...await version('SERVICE_LISTING', listing.id) };
    const results = await Promise.all([decideWorkspaceCase(first.id, admin.id, input), decideWorkspaceCase(first.id, admin.id, input)]);
    assert.ok(results.every(item => item.status === 'RESOLVED'));
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: listing.id } })).status, 'SUSPENDED');
    assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: first.id, action: 'CONTENT_CASE_RESOLVED' } }), 1);
    assert.equal(await prisma.notification.count({ where: { userId: owner.id, title: 'Content warning' } }), 1);
    assert.equal(await prisma.notification.count({ where: { userId: reporter.id, title: 'Content warning' } }), 0);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { resourceId: first.id, action: 'CONTENT_CASE_RESOLVED' } }); assert.equal(audit.targetUserId, owner.id);
    await assert.rejects(decideWorkspaceCase(first.id, admin.id, { ...input, decision: 'KEEP', penalty: 'none' }), (e: any) => e.status === 409);
  });

  await t.test('a successful owner appeal actually restores a listing; failed eligibility leaves the case open', async () => {
    const appeal = await submitContentCase(owner.id, { caseType: 'APPEAL', contentType: 'SERVICE_LISTING', resourceId: listing.id, reason: 'Please review whether the removal was warranted.' });
    const input = { decision: 'RESTORE' as const, penalty: 'none' as const, resolution: 'Reviewed the content and approved restoration.', suspensionDays: 7, ...await version('SERVICE_LISTING', listing.id) };
    await prisma.category.update({ where: { id: category.id }, data: { isActive: false } });
    await assert.rejects(decideWorkspaceCase(appeal.id, admin.id, input), (e: any) => e.status === 409);
    assert.equal((await prisma.contentModerationCase.findUniqueOrThrow({ where: { id: appeal.id } })).status, 'OPEN');
    assert.equal(await prisma.adminAuditLog.count({ where: { resourceId: appeal.id } }), 0);
    await prisma.category.update({ where: { id: category.id }, data: { isActive: true } });
    await decideWorkspaceCase(appeal.id, admin.id, input);
    assert.equal((await readPublicContent(prisma, 'SERVICE_LISTING', listing.id))?.visibility, 'Public');
    assert.equal((await getWorkspaceCase(appeal.id)).decision, 'RESTORE');
  });

  await t.test('seeker request removal closes pending offers and approved appeals restore only the request', async () => {
    const offer = await prisma.offer.create({ data: { requestId: request.id, providerId: owner.id, offeredPrice: 500, estimatedDuration: 60 } });
    const report = await submitContentCase(owner.id, { caseType: 'REPORT', contentType: 'SERVICE_REQUEST', resourceId: request.id, reason: 'Please investigate the public request description.' });
    await decideWorkspaceCase(report.id, admin.id, { decision: 'REMOVE', penalty: 'none', resolution: 'This request needs to be removed after reviewing the report.', suspensionDays: 7, ...await version('SERVICE_REQUEST', request.id) });
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status, 'REJECTED');
    const appeal = await submitContentCase(reporter.id, { caseType: 'APPEAL', contentType: 'SERVICE_REQUEST', resourceId: request.id, reason: 'Please review the removal of my public request.' });
    await decideWorkspaceCase(appeal.id, admin.id, { decision: 'RESTORE', penalty: 'none', resolution: 'Reviewed the removal and restored the public request.', suspensionDays: 7, ...await version('SERVICE_REQUEST', request.id) });
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'OPEN');
    assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).status, 'REJECTED');
    const ordinaryCanceled = await prisma.serviceRequest.create({ data: { seekerId: reporter.id, categoryId: category.id, title: 'Canceled request', description: 'Owner closed this request voluntarily.', budgetMin: 500, budgetMax: 500, urgency: 'Flexible', status: 'CANCELED' } });
    await assert.rejects(changeWorkspaceContent('SERVICE_REQUEST', ordinaryCanceled.id, admin.id, { action: 'RESTORE', reason: 'Attempt to restore voluntary cancellation.', expectedUpdatedAt: ordinaryCanceled.updatedAt.toISOString() }), (e: any) => e.status === 409);
  });

  await t.test('matched request guards preserve booking and payment obligations', async () => {
    const offer = await prisma.offer.create({ data: { requestId: request.id, providerId: owner.id, offeredPrice: 500, estimatedDuration: 60, status: 'ACCEPTED' } });
    const booking = await prisma.booking.create({ data: { seekerId: reporter.id, providerId: owner.id, offerId: offer.id, status: 'WAITING', paymentMethod: 'GCash', paymentStatus: 'PAID_HELD', agreedAmount: 500 } });
    const item = await readPublicContent(prisma, 'SERVICE_REQUEST', request.id); assert.equal(item?.canRemove, false);
    await assert.rejects(changeWorkspaceContent('SERVICE_REQUEST', request.id, admin.id, { action: 'REMOVE', reason: 'Try removing an engaged request.', expectedUpdatedAt: item!.updatedAt.toISOString() }), (e: any) => e.status === 409);
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).paymentStatus, 'PAID_HELD');
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, 'OPEN');
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELED', paymentStatus: 'REFUNDED' } });
  });

  await t.test('stale decisions reject before changes and dismissal applies no owner penalty', async () => {
    const report = await reportListing(); const old = await version('SERVICE_LISTING', listing.id);
    await prisma.service.update({ where: { id: listing.id }, data: { description: 'The faucet repair price and scheduling have been clarified.' } });
    await assert.rejects(decideWorkspaceCase(report.id, admin.id, { decision: 'REMOVE', penalty: 'none', resolution: 'Reviewed the old description and attempted removal.', suspensionDays: 7, ...old }), (e: any) => e.status === 409);
    assert.equal((await prisma.contentModerationCase.findUniqueOrThrow({ where: { id: report.id } })).status, 'OPEN');
    await decideWorkspaceCase(report.id, admin.id, { decision: 'KEEP', penalty: 'none', resolution: 'The revised content meets the rules. No violation was established.', suspensionDays: 7 });
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: listing.id } })).status, 'ACTIVE');
  });

  await t.test('suspension blockers roll back the entire decision; ban preserves jobs for admin handling', async () => {
    const report = await reportListing();
    const booking = await prisma.booking.create({ data: { seekerId: reporter.id, providerId: owner.id, serviceId: listing.id, status: 'ACCEPTED', paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID', agreedAmount: 500 } });
    const input = { decision: 'REMOVE' as const, penalty: 'suspend' as const, resolution: 'Confirmed misleading public content after review.', suspensionDays: 7, ...await version('SERVICE_LISTING', listing.id) };
    await assert.rejects(decideWorkspaceCase(report.id, admin.id, input), (e: any) => e.status === 409);
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: listing.id } })).status, 'ACTIVE');
    assert.equal((await prisma.contentModerationCase.findUniqueOrThrow({ where: { id: report.id } })).status, 'OPEN');
    await decideWorkspaceCase(report.id, admin.id, { ...input, penalty: 'ban' });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).moderationStatus, 'BANNED');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: reporter.id } })).moderationStatus, 'ACTIVE');
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'ACCEPTED');
    assert.equal((await getWorkspaceCase(report.id)).obligations.bookings, 1);
  });

  await t.test('filters separate reports, appeals, provider listings, and seeker requests', async () => {
    const history = await listWorkspaceCases({ page: 1, limit: 50, status: 'RESOLVED', caseType: 'APPEAL', contentType: 'SERVICE_REQUEST' });
    assert.ok(history.items.length); assert.ok(history.items.every(item => item.caseType === 'APPEAL' && item.contentType === 'SERVICE_REQUEST'));
    const items = await listWorkspaceContent({ page: 1, limit: 50, contentType: 'SERVICE_LISTING', search: 'faucet' });
    assert.equal(items.items.length, 1); assert.equal(items.items[0].id, listing.id);
  });
});
