import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { assertCategoryDevelopmentTarget } from './category-development-target';
import { prisma } from '../src/lib/prisma';
import { ensureDefaultServiceCategories } from '../src/services/category-catalog.service';
import { isFallbackCategory } from '../src/lib/category-catalog';

async function main() {
  assertCategoryDevelopmentTarget();
  const before = await prisma.category.findMany({ orderBy: { name: 'asc' } });
  const listingReferences = await prisma.service.findMany({ select: { id: true, categoryId: true }, orderBy: { id: 'asc' } });
  const requestReferences = await prisma.serviceRequest.findMany({ select: { id: true, categoryId: true }, orderBy: { id: 'asc' } });
  const snapshot = `.database-backups/categories-before-${Date.now()}.json`;
  await fs.mkdir('.database-backups', { recursive: true });
  await fs.writeFile(snapshot, JSON.stringify({ before, listingReferences, requestReferences }, null, 2), { flag: 'wx' });
  // No general seed, migrations, account bootstrap, reset, or other model writes.
  const result = await ensureDefaultServiceCategories();
  const after = await prisma.category.findMany({ orderBy: { name: 'asc' } });
  for (const old of before) {
    const kept = after.find(category => category.id === old.id);
    assert.ok(kept, 'Existing category ID was lost');
    assert.equal(kept.name, old.name, 'Existing category label changed');
    if (!isFallbackCategory(old.name)) assert.equal(kept.isActive, old.isActive, 'Admin category status changed');
  }
  assert.deepEqual(await prisma.service.findMany({ select: { id: true, categoryId: true }, orderBy: { id: 'asc' } }), listingReferences);
  assert.deepEqual(await prisma.serviceRequest.findMany({ select: { id: true, categoryId: true }, orderBy: { id: 'asc' } }), requestReferences);
  console.log(JSON.stringify({ target: 'verified development database', ...result, totalCategories: after.length, existingReferencesPreserved: true, snapshot }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message || 'Category expansion failed' : 'Category expansion failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
