import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getCategories } from '../controllers/categories.controller';
import { getCommunityStats } from '../controllers/community.controller';
import { createManagedCategory, updateManagedCategory } from '../services/admin-moderation.service';
import { createRequest } from '../services/requests.service';
import { createService } from '../services/services.service';
import { CreateServiceSchema } from '../schema/services.schema';

async function activeCategories() {
  let body: { success: boolean; data: Array<{ id: string; name: string }> } | undefined;
  await getCategories({} as any, {
    json(value: typeof body) { body = value; return this; },
  } as any, (error) => { if (error) throw error; });
  assert.ok(body?.success);
  return body.data;
}

async function recentCategories() {
  let body: { data: { recentCategories: Array<{ id: string; name: string; addedAt: Date }> } } | undefined;
  await getCommunityStats({} as any, {
    json(value: typeof body) { body = value; return this; },
  } as any, (error) => { if (error) throw error; });
  assert.ok(body);
  return body.data.recentCategories;
}

test('Admin category creation, rename and retirement use one ID for seeker and provider records', async () => {
  const suffix = randomUUID();
  const admin = await prisma.user.create({ data: {
    name: `Category Admin ${suffix}`, email: `category-admin-${suffix}@example.test`,
    passwordHash: 'test-only', phone: 'test-only', location: 'Cordova', role: 'admin', emailVerified: true,
  } });
  const seeker = await prisma.user.create({ data: {
    name: `Category Seeker ${suffix}`, email: `category-seeker-${suffix}@example.test`,
    passwordHash: 'test-only', phone: 'test-only', location: 'Cordova',
    emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const provider = await prisma.user.create({ data: {
    name: `Category Provider ${suffix}`, email: `category-provider-${suffix}@example.test`,
    passwordHash: 'test-only', phone: 'test-only', location: 'Cordova',
    emailVerified: true, verificationStatus: 'APPROVED',
  } });
  const originalName = `Local Skill ${suffix}`;
  const renamedName = `Community Skill ${suffix}`;

  await createManagedCategory(admin.id, { name: originalName, reason: 'Add a category for catalog integration testing' });
  const created = await prisma.category.findUniqueOrThrow({ where: { name: originalName } });
  const categoryId = created.id;
  assert.equal(created.isActive, true);
  assert.equal((await activeCategories()).find(item => item.id === categoryId)?.name, originalName);
  const creationEvent = await prisma.adminAuditLog.findFirstOrThrow({ where: { resourceId: categoryId, action: 'CATEGORY_CREATED' } });
  assert.equal((await recentCategories()).find(item => item.id === categoryId)?.addedAt.getTime(), creationEvent.createdAt.getTime());
  await assert.rejects(createManagedCategory(admin.id, { name: `  ${originalName.toUpperCase()}  `, reason: 'Reject duplicate category' }), /already exists/);

  const request = await createRequest(seeker.id, {
    categoryId, title: `Need local help ${suffix}`, description: 'A detailed request for this newly added local service.',
    budgetMin: 500, budgetMax: 500, urgency: 'This Week',
  });
  const listing = await createService(provider.id, CreateServiceSchema.parse({
    categoryId, title: `Offer local help ${suffix}`, description: 'A sufficiently detailed service listing for this new local skill.',
    price: 500, estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true },
    serviceLocation: { latitude: 10.3, longitude: 123.9, label: 'Service base' },
  }));
  assert.equal(request.categoryId, categoryId);
  assert.equal(listing.categoryId, categoryId);

  await updateManagedCategory(categoryId, admin.id, { name: renamedName, reason: 'Category naming update' });
  assert.equal((await activeCategories()).find(item => item.id === categoryId)?.name, renamedName);
  assert.equal((await recentCategories()).find(item => item.id === categoryId)?.name, renamedName);
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id }, include: { category: true } })).category.name, renamedName);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: listing.id }, include: { category: true } })).category.name, renamedName);
  await assert.rejects(
    updateManagedCategory(categoryId, admin.id, { isActive: false, reason: 'Too early to retire' }),
    /cannot be deactivated/,
  );

  // Admin rules require open requests and non-deleted listings to finish first.
  await prisma.serviceRequest.update({ where: { id: request.id }, data: { status: 'CANCELED' } });
  await prisma.service.update({ where: { id: listing.id }, data: { status: 'DELETED', isAvailable: false } });
  await updateManagedCategory(categoryId, admin.id, { isActive: false, reason: 'Retire unused category' });
  assert.equal((await activeCategories()).some(item => item.id === categoryId), false);
  assert.equal((await recentCategories()).some(item => item.id === categoryId), false);
  await assert.rejects(createRequest(seeker.id, {
    categoryId, title: 'Retired category request', description: 'A request that should not be accepted.',
    budgetMin: 500, budgetMax: 500, urgency: 'Flexible Schedule',
  }), /Invalid or inactive category/);
  await assert.rejects(createService(provider.id, CreateServiceSchema.parse({
    categoryId, title: `Retired skill ${suffix}`, description: 'A sufficiently detailed service listing for a retired local skill.',
    price: 500, estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true },
    serviceLocation: { latitude: 10.3, longitude: 123.9, label: 'Service base' },
  })), /Invalid or inactive category/);

  const historicalRequest = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id }, include: { category: true } });
  const historicalListing = await prisma.service.findUniqueOrThrow({ where: { id: listing.id }, include: { category: true } });
  assert.equal(historicalRequest.categoryId, categoryId);
  assert.equal(historicalListing.categoryId, categoryId);
  assert.equal(historicalRequest.category.name, renamedName);
  assert.equal(historicalListing.category.name, renamedName);

  await updateManagedCategory(categoryId, admin.id, { isActive: true, reason: 'Reactivate the category' });
  assert.equal((await activeCategories()).find(item => item.id === categoryId)?.name, renamedName);
  assert.equal((await recentCategories()).find(item => item.id === categoryId)?.addedAt.getTime(), creationEvent.createdAt.getTime());
});
