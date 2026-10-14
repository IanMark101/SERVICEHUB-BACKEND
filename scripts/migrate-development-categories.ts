import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertCategoryDevelopmentTarget } from './category-development-target';
import { prisma } from '../src/lib/prisma';
import { env } from '../src/config/env';
import { canonicalCategoryName, categoryConceptKey, DEFAULT_SERVICE_CATEGORIES } from '../src/lib/category-catalog';

const migrationName = '20261013020000_service_category_cleanup';

async function main() {
  assertCategoryDevelopmentTarget();
  assert.equal(env.NODE_ENV, 'development', 'Category cleanup only targets development');
  const completed = await prisma.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const files = (await fs.readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const pending = files.filter(name => !completed.some(row => row.migration_name === name));
  if (!pending.length) { console.log('Category cleanup is already applied.'); return; }
  assert.deepEqual(pending, [migrationName], 'Refusing to deploy unrelated pending migrations');
  const before = await prisma.category.findMany({ orderBy: { id: 'asc' } });
  const listingReferences = await prisma.service.findMany({ select: { id: true, categoryId: true, status: true, updatedAt: true }, orderBy: { id: 'asc' } });
  const requestReferences = await prisma.serviceRequest.findMany({ select: { id: true, categoryId: true, status: true, updatedAt: true }, orderBy: { id: 'asc' } });
  await fs.mkdir('.database-backups', { recursive: true });
  const snapshot = `.database-backups/categories-cleanup-before-${Date.now()}.json`;
  await fs.writeFile(snapshot, JSON.stringify({ before, listingReferences, requestReferences }, null, 2), { flag: 'wx' });
  const migration = spawnSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'], { encoding: 'utf8', env: process.env });
  if (migration.stdout) process.stdout.write(migration.stdout);
  if (migration.stderr) process.stderr.write(migration.stderr);
  if (migration.error) throw migration.error;
  assert.equal(migration.status, 0, 'Category migration deployment failed');
  const after = await prisma.category.findMany({ orderBy: { name: 'asc' } });
  for (const old of before) assert.ok(after.some(category => category.id === old.id), 'A historical category ID was lost');
  const active = after.filter(category => category.isActive);
  assert.equal(new Set(active.map(category => categoryConceptKey(category.name))).size, active.length, 'Duplicate active concepts remain');
  for (const name of DEFAULT_SERVICE_CATEGORIES) assert.ok(after.some(category => category.name === name), `Missing category: ${name}`);
  const survivingId = (oldId: string) => {
    const old = before.find(category => category.id === oldId)!;
    return after.find(category => category.name === canonicalCategoryName(old.name))?.id ?? oldId;
  };
  assert.deepEqual(await prisma.service.findMany({ select: { id: true, categoryId: true, status: true, updatedAt: true }, orderBy: { id: 'asc' } }), listingReferences.map(row => ({ ...row, categoryId: survivingId(row.categoryId) })));
  assert.deepEqual(await prisma.serviceRequest.findMany({ select: { id: true, categoryId: true, status: true, updatedAt: true }, orderBy: { id: 'asc' } }), requestReferences.map(row => ({ ...row, categoryId: survivingId(row.categoryId) })));
  console.log(JSON.stringify({ target: 'verified development database', activeCategories: active.length, retiredCategories: after.length - active.length, listingsPreserved: listingReferences.length, requestsPreserved: requestReferences.length, snapshot }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Category cleanup failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
