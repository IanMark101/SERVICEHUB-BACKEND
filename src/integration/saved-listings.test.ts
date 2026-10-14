import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { getSavedListings, getSavedListingStatus, saveListing, unsaveListing } from '../services/saved-listings.service';
import { submitContentCase } from '../services/content-moderation-cases.service';

assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
after(() => prisma.$disconnect());

test('Saved listings and report actions preserve marketplace privacy and ownership', async t => {
  const tag = randomUUID();
  const makeUser = (name: string, role = 'user') => prisma.user.create({ data: { name, email: `${name}-${tag}@example.test`, passwordHash: 'unused', phone: '', location: 'Cordova', role, emailVerified: true, verificationStatus: 'APPROVED' } });
  const [seeker, provider, other, admin] = await Promise.all([makeUser('Seeker'), makeUser('Provider'), makeUser('Other'), makeUser('Admin', 'admin')]);
  const category = await prisma.category.create({ data: { name: `Saved repairs ${tag}` } });
  const service = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: 'LAPTOP REPAIR', titleNormalized: 'laptop repair', description: 'Laptop diagnostics and repair.', price: 500, estimatedDurationMins: 60, status: 'ACTIVE', isAvailable: true, paymentMethods: { cash: true, gcash: true }, latitude: 10.26, longitude: 123.95, locationLabel: 'Cordova', venueAddress: 'PRIVATE VENUE' } });
  const request = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id, title: 'LAPTOP DOES NOT START', description: 'Check my laptop and repair the power issue.', budgetMin: 500, budgetMax: 1000, urgency: 'This Week', latitude: 10.26, longitude: 123.95, locationLabel: 'Cordova', privateAddress: 'PRIVATE HOME' } });
  const inquiry = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id, title: 'Private inquiry', description: 'Private', budgetMin: 500, budgetMax: 500, urgency: 'This Week', targetServiceId: service.id, targetProviderId: provider.id } });

  await t.test('both target types persist once under concurrent duplicate saves', async () => {
    await Promise.all(Array.from({ length: 4 }, () => saveListing(seeker.id, 'SERVICE_LISTING', service.id)));
    await Promise.all(Array.from({ length: 3 }, () => saveListing(provider.id, 'SERVICE_REQUEST', request.id)));
    assert.equal(await prisma.savedListing.count({ where: { userId: seeker.id } }), 1);
    assert.equal(await prisma.savedListing.count({ where: { userId: provider.id } }), 1);
    assert.deepEqual(await getSavedListingStatus(seeker.id, 'SERVICE_LISTING', [service.id]), [service.id]);
    assert.deepEqual(await getSavedListingStatus(other.id, 'SERVICE_LISTING', [service.id]), []);
    const services = await getSavedListings(seeker.id, 'SERVICE_LISTING', 1, 12);
    const requests = await getSavedListings(provider.id, 'SERVICE_REQUEST', 1, 12);
    assert.equal(services.items[0].listing?.id, service.id); assert.equal(requests.items[0].listing?.id, request.id);
    assert.ok(!JSON.stringify(services).includes('PRIVATE VENUE')); assert.ok(!JSON.stringify(requests).includes('PRIVATE HOME'));
    assert.equal('latitude' in requests.items[0].listing!, false);
    assert.equal((await getSavedListings(seeker.id, 'SERVICE_REQUEST', 1, 12)).items.length, 0);
  });
  await t.test('own, unavailable and private listings cannot be saved; database rejects invalid target combinations', async () => {
    await assert.rejects(saveListing(provider.id, 'SERVICE_LISTING', service.id), /own listing/);
    await assert.rejects(saveListing(seeker.id, 'SERVICE_REQUEST', request.id), /own listing/);
    await assert.rejects(saveListing(other.id, 'SERVICE_REQUEST', inquiry.id), /no longer available/);
    await assert.rejects(prisma.savedListing.create({ data: { userId: other.id, serviceId: service.id, requestId: request.id } }));
    await assert.rejects(prisma.savedListing.create({ data: { userId: other.id } }));
    await prisma.service.update({ where: { id: service.id }, data: { isAvailable: false } });
    assert.equal((await getSavedListings(seeker.id, 'SERVICE_LISTING', 1, 12)).items[0].listing, null);
    await assert.rejects(saveListing(other.id, 'SERVICE_LISTING', service.id), /no longer available/);
    await prisma.service.update({ where: { id: service.id }, data: { isAvailable: true } });
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { archivedAt: new Date() } });
    assert.equal((await getSavedListings(provider.id, 'SERVICE_REQUEST', 1, 12)).items[0].listing, null);
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { archivedAt: null } });
  });
  await t.test('authenticated API scopes saved items to the session; fresh sessions retain them and private details stay inaccessible', async () => {
    const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api`;
    const token = async (user: typeof seeker) => {
      const session = await prisma.refreshToken.create({ data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
      return jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1m' });
    };
    try {
      assert.equal((await fetch(`${base}/saved?contentType=SERVICE_LISTING`)).status, 401);
      assert.equal((await fetch(`${base}/saved?contentType=SERVICE_LISTING`, { headers: { Authorization: `Bearer ${await token(admin)}` } })).status, 403);
      const oldSession = await token(seeker);
      const first = await fetch(`${base}/saved?contentType=SERVICE_LISTING`, { headers: { Authorization: `Bearer ${oldSession}` } });
      assert.equal(first.status, 200); assert.equal((await first.json() as any).data.items.length, 1);
      await prisma.refreshToken.deleteMany({ where: { userId: seeker.id } });
      assert.equal((await fetch(`${base}/saved?contentType=SERVICE_LISTING`, { headers: { Authorization: `Bearer ${oldSession}` } })).status, 401);
      const fresh = await fetch(`${base}/saved?contentType=SERVICE_LISTING`, { headers: { Authorization: `Bearer ${await token(seeker)}` } });
      assert.equal((await fresh.json() as any).data.items.length, 1);
      const otherHeaders = { Authorization: `Bearer ${await token(other)}` };
      assert.equal((await fetch(`${base}/saved?contentType=SERVICE_LISTING`, { headers: otherHeaders }).then(r => r.json()) as any).data.items.length, 0);
      assert.equal((await fetch(`${base}/requests/${inquiry.id}`, { headers: otherHeaders })).status, 404);
      const publicDetail = await fetch(`${base}/requests/${request.id}`, { headers: otherHeaders });
      assert.equal(publicDetail.status, 200); assert.ok(!(await publicDetail.text()).includes('PRIVATE HOME'));
      await fetch(`${base}/saved/SERVICE_LISTING/${service.id}`, { method: 'DELETE', headers: otherHeaders });
      assert.equal(await prisma.savedListing.count({ where: { userId: seeker.id } }), 1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  await t.test('reports reach the existing case flow, reject own listings and prevent open duplicate reports for both types', async () => {
    const reason = 'This listing contains misleading information. Please review it.';
    for (const [submitterId, contentType, resourceId] of [[seeker.id, 'SERVICE_LISTING', service.id], [provider.id, 'SERVICE_REQUEST', request.id]] as const) {
      const report = await submitContentCase(submitterId, { caseType: 'REPORT', contentType, resourceId, reason });
      assert.equal(report.status, 'OPEN');
      await assert.rejects(submitContentCase(submitterId, { caseType: 'REPORT', contentType, resourceId, reason }), /already have an open review/);
    }
    await assert.rejects(submitContentCase(provider.id, { caseType: 'REPORT', contentType: 'SERVICE_LISTING', resourceId: service.id, reason }), /own listing/);
    await assert.rejects(submitContentCase(seeker.id, { caseType: 'REPORT', contentType: 'SERVICE_REQUEST', resourceId: request.id, reason }), /own request/);
    assert.equal(await prisma.contentModerationCase.count({ where: { resourceId: { in: [service.id, request.id] } } }), 2);
  });
  await t.test('unsave is idempotent, closed requests stay private and target/user deletion cascades bookmarks', async () => {
    await unsaveListing(seeker.id, 'SERVICE_LISTING', service.id); await unsaveListing(seeker.id, 'SERVICE_LISTING', service.id);
    assert.equal(await prisma.savedListing.count({ where: { userId: seeker.id } }), 0);
    await prisma.serviceRequest.update({ where: { id: request.id }, data: { status: 'CANCELED' } });
    assert.equal((await getSavedListings(provider.id, 'SERVICE_REQUEST', 1, 12)).items[0].listing, null);
    await unsaveListing(provider.id, 'SERVICE_REQUEST', request.id);
    await saveListing(other.id, 'SERVICE_LISTING', service.id);
    await prisma.user.delete({ where: { id: other.id } });
    assert.equal(await prisma.savedListing.count({ where: { userId: other.id } }), 0);
    await saveListing(seeker.id, 'SERVICE_LISTING', service.id);
    await prisma.service.delete({ where: { id: service.id } });
    assert.equal(await prisma.savedListing.count({ where: { serviceId: service.id } }), 0);
  });
});
