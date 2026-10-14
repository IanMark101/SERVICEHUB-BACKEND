import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { DEFAULT_SERVICE_CATEGORIES, categoryConceptKey } from '../lib/category-catalog';
import { createManagedCategory, updateManagedCategory } from '../services/admin-moderation.service';
import { getCategories } from '../controllers/categories.controller';
import { ensureDefaultServiceCategories } from '../services/category-catalog.service';

test('category cleanup preserves both listing types, historical IDs, Admin decisions and custom categories', async t => {
  const schema = new URL(env.DATABASE_URL).searchParams.get('schema') || '';
  assert.match(schema, /^servicehub_migration_test_[a-f0-9]{32}$/, 'Only run in the disposable schema');
  t.after(() => prisma.$disconnect());
  await prisma.category.deleteMany();
  const names = ['Cleaning Services', 'House Cleaning', 'Home & Office Cleaning', '  HOME and OFFICE cleaning  ', 'Lawn Care', 'Lawn & Garden', 'Tutoring', 'Tutoring & Education', 'Electrical Repair', 'Computer / IT Services', 'Repair & Maintenance', 'Other Services', 'Painting Services', 'Custom Skill'];
  await prisma.category.createMany({ data: names.map(name => ({ name, isActive: !['Painting Services', 'Other Services'].includes(name) })) });
  const before = await prisma.category.findMany();
  const byName = (name: string) => before.find(category => category.name === name)!;
  const member = await prisma.user.create({ data: { name: 'Category fixture', email: `catalog-${schema}@example.test`, passwordHash: 'test-only', phone: 'test-only', location: 'Cordova', role: 'admin' } });
  const historicalAudit = await prisma.adminAuditLog.create({ data: { actorId: member.id, action: 'CATEGORY_CREATED', resourceType: 'Category', resourceId: byName('House Cleaning').id, reason: 'Historical fixture' } });
  const listing = await prisma.service.create({ data: { providerId: member.id, categoryId: byName('House Cleaning').id, title: 'Retained cleaning', titleNormalized: 'retained cleaning', description: 'Clean the house', price: 500, estimatedDurationMins: 60, paymentMethods: { cash: true } } });
  const request = await prisma.serviceRequest.create({ data: { seekerId: member.id, categoryId: byName('Cleaning Services').id, title: 'Retained request', description: 'Clean the office', budgetMin: 500, budgetMax: 500, urgency: 'This Week' } });
  const sql = readFileSync('prisma/migrations/20261013020000_service_category_cleanup/migration.sql', 'utf8');
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    assert.equal((await client.query('SELECT current_schema() AS name')).rows[0].name, schema);
    await client.query(sql);
    const categories = await prisma.category.findMany();
    for (const old of before) assert.ok(categories.some(category => category.id === old.id), 'Historical ID retained');
    const active = categories.filter(category => category.isActive);
    assert.equal(new Set(active.map(category => categoryConceptKey(category.name))).size, active.length);
    const keeper = byName('Home & Office Cleaning').id;
    assert.deepEqual(await prisma.service.findUniqueOrThrow({ where: { id: listing.id } }), { ...listing, categoryId: keeper });
    assert.deepEqual(await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } }), { ...request, categoryId: keeper });
    for (const alias of ['Cleaning Services', 'House Cleaning', 'Repair & Maintenance']) {
      assert.equal(categories.find(category => category.id === byName(alias).id)?.isActive, false);
    }
    assert.equal(categories.find(category => category.id === byName('Painting Services').id)?.isActive, false);
    assert.equal(categories.find(category => category.id === byName('Electrical Repair').id)?.name, 'Electrical Wiring & Repairs');
    assert.equal(categories.find(category => category.id === byName('Custom Skill').id)?.name, 'Custom Skill');
    assert.equal((await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: historicalAudit.id } })).resourceId, byName('House Cleaning').id);
    assert.equal(categories.find(category => category.name === 'Other Services')?.isActive, true);
    assert.deepEqual([...DEFAULT_SERVICE_CATEGORIES].sort(), categories.filter(category => category.name !== 'Custom Skill' && DEFAULT_SERVICE_CATEGORIES.includes(category.name as any)).map(category => category.name).sort());
    await client.query(sql);
    assert.deepEqual((await prisma.category.findMany({ orderBy: { id: 'asc' } })), [...categories].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual((await ensureDefaultServiceCategories()).added, []);
    let response: any;
    await getCategories({} as any, { json(body: any) { response = body; } } as any, error => { if (error) throw error; });
    assert.equal(response.data.some((category: any) => category.name === 'House Cleaning'), false);
    assert.match(response.data.find((category: any) => category.name === 'Computer & Laptop Repair').description, /Laptop/);

    for (const name of ['House Cleaning', 'home and office cleaning', '  LAWN CARE ', 'Tutoring & Education', 'Computer / IT Services', 'Repair & Maintenance']) {
      await assert.rejects(createManagedCategory(member.id, { name, reason: 'Duplicate test' }), /already exists/);
    }
    await assert.rejects(updateManagedCategory(byName('House Cleaning').id, member.id, { isActive: true, reason: 'Duplicate activation' }), /already exists/);
    await assert.rejects(updateManagedCategory(byName('Custom Skill').id, member.id, { name: 'House Cleaning', reason: 'Duplicate rename' }), /already exists/);
    // An inactive merged alias must not block the surviving category's own activation.
    await prisma.service.delete({ where: { id: listing.id } });
    await prisma.serviceRequest.delete({ where: { id: request.id } });
    await updateManagedCategory(keeper, member.id, { isActive: false, reason: 'Retire canonical fixture' });
    await updateManagedCategory(keeper, member.id, { isActive: true, reason: 'Reactivate canonical fixture' });
  } finally {
    await client.end();
    await prisma.adminAuditLog.deleteMany({ where: { actorId: member.id } });
    await prisma.user.delete({ where: { id: member.id } });
  }
});
