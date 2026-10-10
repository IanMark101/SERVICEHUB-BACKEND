import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { DEFAULT_SERVICE_CATEGORIES, normalizedCategoryName } from '../lib/category-catalog';
import { ensureDefaultServiceCategories } from '../services/category-catalog.service';
import { assessMarketplaceContent } from '../services/content-moderation.service';
import { respondToDirectBookingService } from '../services/bookings/direct-bookings.service';
import { providerStartJob } from '../services/bookings/provider-operations.service';
import { markJobComplete, confirmCompletionService } from '../services/bookings/completion.service';

test('expanded Admin catalog preserves data and supports both marketplace flows', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/, 'Requires a disposable migration-test schema');
  t.after(() => prisma.$disconnect());
  const suffix = randomUUID();
  const legacy = ['Aircon Service', 'Appliance Repair', 'Carpentry & Woodwork', 'Electrical Repair', 'House Cleaning', 'Lawn Care', 'Plumbing', 'Tutoring'];
  await prisma.category.createMany({ data: legacy.map(name => ({ name })) });
  await prisma.category.create({ data: { name: 'Painting Services', isActive: false } });
  await prisma.category.create({ data: { name: '  beauty & personal care  ' } });
  const before = await prisma.category.findMany({ orderBy: { id: 'asc' } });
  const makeUser = (name: string, role: 'admin' | 'user' = 'user', approved = true) => prisma.user.create({ data: {
    name, email: `${name}-${suffix}@example.test`, passwordHash: 'test-only', phone: 'test-only',
    role, emailVerified: true, verificationStatus: approved ? 'APPROVED' : 'UNVERIFIED', location: 'Cebu',
  } });
  const admin = await makeUser('CatalogAdmin', 'admin');
  const seeker = await makeUser('CatalogSeeker');
  const provider = await makeUser('CatalogProvider');
  const unverified = await makeUser('UnverifiedCatalogMember', 'user', false);
  const plumbing = before.find(c => c.name === 'Plumbing')!;
  const retainedListing = await prisma.service.create({ data: { providerId: provider.id, categoryId: plumbing.id, title: 'Retained plumbing', titleNormalized: 'retained plumbing', description: 'Retained plumbing record', price: 500, estimatedDurationMins: 60, paymentMethods: { cash: true }, status: 'DELETED', isAvailable: false } });
  const retainedRequest = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: plumbing.id, title: 'Retained plumbing request', description: 'Retained request record', budgetMin: 500, budgetMax: 500, urgency: 'Flexible Schedule' } });

  await t.test('additive seed is normalized, idempotent and preserves Admin status and legacy references', async () => {
    const seeded = await ensureDefaultServiceCategories();
    assert.equal(seeded.added.length, 14);
    const after = await prisma.category.findMany();
    assert.equal(after.length, 24);
    for (const old of before) assert.deepEqual(after.find(c => c.id === old.id), old);
    for (const name of DEFAULT_SERVICE_CATEGORIES) assert.equal(after.filter(c => normalizedCategoryName(c.name) === normalizedCategoryName(name)).length, 1);
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: retainedListing.id } })).categoryId, plumbing.id);
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: retainedRequest.id } })).categoryId, plumbing.id);
    assert.deepEqual((await ensureDefaultServiceCategories()).added, []);
    assert.equal((await prisma.category.findUniqueOrThrow({ where: { name: 'Painting Services' } })).isActive, false);
  });
  const fallback = await prisma.category.findUniqueOrThrow({ where: { name: 'Other Services' } });
  const computer = await prisma.category.findUniqueOrThrow({ where: { name: 'Computer / IT Services' } });
  const tokens = new Map<string, string>();
  for (const user of [admin, seeker, provider, unverified]) {
    const session = await prisma.refreshToken.create({ data: { userId: user.id, token: createHash('sha256').update(`${user.id}-${suffix}`).digest('hex'), expiresAt: new Date(Date.now() + 900000) } });
    tokens.set(user.id, jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '15m' }));
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (path: string, userId: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${tokens.get(userId)}`, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() as any };
  };
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  await t.test('fallback cannot be renamed or deactivated; members cannot create categories', async () => {
    for (const body of [{ name: 'Miscellaneous', reason: 'Attempt fallback rename' }, { isActive: false, reason: 'Attempt fallback retirement' }]) {
      const result = await call(`/admin/categories/${fallback.id}`, admin.id, body, 'PATCH');
      assert.equal(result.status, 409, result.error);
    }
    for (const member of [seeker, provider]) assert.equal((await call('/admin/categories', member.id, { name: 'Member category', reason: 'Not allowed' })).status, 403);
    await prisma.category.update({ where: { id: fallback.id }, data: { isActive: false } });
    assert.equal((await ensureDefaultServiceCategories()).fallbackReactivated, true);
    assert.equal((await prisma.category.findUniqueOrThrow({ where: { id: fallback.id } })).isActive, true);
  });

  let createdCategoryId = '';
  await t.test('Admin creation, duplicate rejection, rename, activation and pagination still work', async () => {
    const created = await call('/admin/categories', admin.id, { name: 'Instrument Services', reason: 'Add a broad service family' });
    assert.equal(created.status, 201, created.error); createdCategoryId = created.data.id;
    assert.equal((await call('/admin/categories', admin.id, { name: ' instrument   SERVICES ', reason: 'Duplicate test' })).status, 409);
    const changed = await call(`/admin/categories/${createdCategoryId}`, admin.id, { name: 'Musical Instrument Services', reason: 'Clarify the service family' }, 'PATCH');
    assert.equal(changed.status, 200, changed.error);
    for (const isActive of [false, true]) assert.equal((await call(`/admin/categories/${createdCategoryId}`, admin.id, { isActive, reason: 'Manage catalog availability' }, 'PATCH')).status, 200);
    const catalog = await call('/admin/categories?page=1&limit=10', admin.id);
    assert.equal(catalog.status, 200); assert.equal(catalog.data.length, 10); assert.equal(catalog.pagination.total, 25);
    const active = await call('/categories', seeker.id);
    assert.equal(active.data.some((c: any) => c.id === fallback.id), true);
    assert.equal(active.data.some((c: any) => c.id === createdCategoryId), true);
  });

  const point = { latitude: 10.305, longitude: 123.9, label: 'Service area' };
  const jobLocation = { ...point, address: 'Private test directions' };
  const requestInput = { budgetMin: 500, budgetMax: 600, urgency: 'Needs Tomorrow', paymentMethods: { cash: true, gcash: true }, jobLocation };
  const listingInput = { price: 500, priceType: 'FIXED', estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: true }, serviceLocation: point, coverageRadiusKm: 2 };
  const requests: any[] = [], listings: any[] = [];
  await t.test('approved members publish official and fallback records; verification and category validation stay enforced', async () => {
    for (const [categoryId, title, description] of [[fallback.id, 'Repair aquarium pump', 'The aquarium circulation pump is noisy and needs inspection and repair.'], [createdCategoryId, 'Tune acoustic piano', 'The acoustic piano needs tuning and careful adjustment.']]) {
      const result = await call('/requests', seeker.id, { ...requestInput, categoryId, title, description });
      assert.equal(result.status, 201, result.error); assert.equal(result.data.categoryId, categoryId); requests.push(result.data);
    }
    for (const [categoryId, title, description] of [[fallback.id, 'Aquarium pump repair', 'Inspection and repair of aquarium circulation pumps and filters.'], [computer.id, 'Laptop motherboard repair', 'Diagnose laptop motherboard faults and repair damaged components.'], [createdCategoryId, 'Piano tuning service', 'Tune acoustic pianos and adjust the instrument carefully.']]) {
      const result = await call('/services', provider.id, { ...listingInput, categoryId, title, description });
      assert.equal(result.status, 201, result.error); assert.equal(result.data.categoryId, categoryId); listings.push(result.data);
    }
    assert.equal((await call('/requests', unverified.id, { ...requestInput, categoryId: fallback.id, title: 'Aquarium pump inspection', description: 'Inspect the aquarium circulation pump and diagnose its fault.' })).status, 403);
    assert.equal((await call('/services', unverified.id, { ...listingInput, categoryId: fallback.id, title: 'Aquarium pump maintenance', description: 'Inspect and maintain aquarium circulation pumps and filters.' })).status, 403);
    const inactive = await prisma.category.findUniqueOrThrow({ where: { name: 'Painting Services' } });
    const invalid = await call('/requests', seeker.id, { ...requestInput, categoryId: inactive.id, title: 'Paint bedroom walls', description: 'Paint all bedroom walls and prepare the surfaces.' });
    assert.equal(invalid.status, 400, invalid.error);
  });

  await t.test('All includes Other; category, title/description search, quick filters and radius combine on both APIs', async () => {
    const query = '?latitude=10.3&longitude=123.9&radiusKm=2&limit=30';
    for (const [endpoint, userId, records, quick] of [['/requests/nearby', provider.id, requests, 'urgent'], ['/services/nearby', seeker.id, listings, 'available']] as const) {
      const ids = (result: any) => result.data.items.map((item: any) => item.id);
      assert.deepEqual(new Set(ids(await call(endpoint + query + '&category=All%20Categories', userId))), new Set(records.map(r => r.id)));
      assert.deepEqual(ids(await call(endpoint + query + '&category=Other%20Services', userId)), [records[0].id]);
      assert.deepEqual(ids(await call(endpoint + query + '&search=aquarium', userId)), [records[0].id]);
      assert.deepEqual(ids(await call(endpoint + query + '&search=circulation&category=Other%20Services&filter=' + quick, userId)), [records[0].id]);
      assert.deepEqual(ids(await call(endpoint + query + '&search=aquarium&category=Plumbing', userId)), []);
      assert.deepEqual(ids(await call(endpoint + query.replace('latitude=10.3', 'latitude=10.4') + '&search=aquarium', userId)), []);
    }
    const laptop = await call('/services/nearby' + query + '&search=motherboard&category=Computer%20%2F%20IT%20Services', seeker.id);
    assert.equal(laptop.data.items[0].id, listings[1].id);
  });

  await t.test('Provider can offer on Other and an Admin-created official category', async () => {
    for (const request of requests) {
      const result = await call('/offers', provider.id, { requestId: request.id, offeredPrice: 550, estimatedDuration: 60, message: 'I can complete this task tomorrow, including travel.' });
      assert.equal(result.status, 201, result.error); assert.equal(result.data.requestId, request.id);
    }
  });

  await t.test('Other and official listings enter and complete the unchanged direct cash booking flow', async () => {
    for (const listing of [listings[0], listings[2]]) {
      const result = await call('/bookings/direct', seeker.id, { serviceId: listing.id, jobLocation, quantity: 1 });
      assert.equal(result.status, 201, result.error);
      const booking = await prisma.booking.findFirstOrThrow({ where: { directRequestId: result.data.id } });
      assert.equal(Number(booking.agreedAmount), 500);
      await respondToDirectBookingService(result.data.id, provider.id, true);
      await providerStartJob(booking.id, provider.id); await markJobComplete(booking.id, provider.id);
      assert.equal((await confirmCompletionService(booking.id, seeker.id)).paymentStatus, 'CASH_CONFIRMED');
    }
  });

  await t.test('fallback preserves existing prohibited-content policy', () => {
    assert.equal(assessMarketplaceContent({ kind: 'SERVICE_LISTING', categoryName: 'Other Services', title: 'Sell firearms', description: 'Buy firearms through this listing.' }).reasonCode, 'PROHIBITED_SERVICE');
    assert.equal(assessMarketplaceContent({ kind: 'SERVICE_REQUEST', categoryName: 'Other Services', title: 'Repair aquarium pump', description: 'Inspect the circulation pump.' }).outcome, 'PASS');
  });
});
