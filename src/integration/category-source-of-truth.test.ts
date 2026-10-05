import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getCategories } from '../controllers/categories.controller';
import { resolveCategory, updateManagedCategory } from '../services/admin-moderation.service';
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

test('Admin category approval, rename and retirement use one ID for seeker and provider records', async (t) => {
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
  const suggestion = await prisma.categorySuggested.create({ data: {
    submitterId: seeker.id, name: originalName, description: 'A local service for category integration testing.',
  } });
  let categoryId: string | undefined;
  t.after(async () => {
    await prisma.serviceRequest.deleteMany({ where: { seekerId: seeker.id } });
    await prisma.service.deleteMany({ where: { providerId: provider.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [admin.id, seeker.id, provider.id] } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: admin.id } });
    await prisma.categorySuggested.deleteMany({ where: { id: suggestion.id } });
    if (categoryId) await prisma.category.delete({ where: { id: categoryId } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, seeker.id, provider.id] } } });
    await prisma.$disconnect();
  });

  await resolveCategory(suggestion.id, admin.id, true);
  const approved = await prisma.category.findUniqueOrThrow({ where: { name: originalName } });
  categoryId = approved.id;
  assert.equal(approved.isActive, true);
  assert.equal((await activeCategories()).find(item => item.id === categoryId)?.name, originalName);

  const request = await createRequest(seeker.id, {
    categoryId, title: `Need local help ${suffix}`, description: 'A detailed request for this newly approved local service.',
    budgetMin: 500, budgetMax: 500, urgency: 'This Week',
  });
  const listing = await createService(provider.id, CreateServiceSchema.parse({
    categoryId, title: `Offer local help ${suffix}`, description: 'A sufficiently detailed service listing for this new local skill.',
    price: 500, estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true },
  }));
  assert.equal(request.categoryId, categoryId);
  assert.equal(listing.categoryId, categoryId);

  await updateManagedCategory(categoryId, admin.id, { name: renamedName, reason: 'Category naming update' });
  assert.equal((await activeCategories()).find(item => item.id === categoryId)?.name, renamedName);
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
  await assert.rejects(createRequest(seeker.id, {
    categoryId, title: 'Retired category request', description: 'A request that should not be accepted.',
    budgetMin: 500, budgetMax: 500, urgency: 'Flexible Schedule',
  }), /Invalid or inactive category/);
  await assert.rejects(createService(provider.id, CreateServiceSchema.parse({
    categoryId, title: `Retired skill ${suffix}`, description: 'A sufficiently detailed service listing for a retired local skill.',
    price: 500, estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true },
  })), /Invalid or inactive category/);

  const historicalRequest = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id }, include: { category: true } });
  const historicalListing = await prisma.service.findUniqueOrThrow({ where: { id: listing.id }, include: { category: true } });
  assert.equal(historicalRequest.categoryId, categoryId);
  assert.equal(historicalListing.categoryId, categoryId);
  assert.equal(historicalRequest.category.name, renamedName);
  assert.equal(historicalListing.category.name, renamedName);

  await updateManagedCategory(categoryId, admin.id, { isActive: true, reason: 'Reactivate the category' });
  assert.equal((await activeCategories()).find(item => item.id === categoryId)?.name, renamedName);
});
