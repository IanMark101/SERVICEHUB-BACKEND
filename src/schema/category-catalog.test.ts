import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { canonicalCategoryName, categoryConceptKey, DEFAULT_SERVICE_CATEGORIES, officialCategoryForName, SERVICE_CATEGORY_CATALOG } from '../lib/category-catalog';
import { assessMarketplaceContent } from '../services/content-moderation.service';

test('known duplicate concepts, punctuation and case variants resolve to one service family', () => {
  assert.equal(categoryConceptKey('House Cleaning'), categoryConceptKey('Cleaning Services'));
  assert.equal(categoryConceptKey('Lawn Care'), categoryConceptKey('Lawn & Garden'));
  assert.equal(categoryConceptKey('Tutoring'), categoryConceptKey('Tutoring & Education'));
  assert.equal(canonicalCategoryName('  computer / IT   services '), 'Computer & Laptop Repair');
  assert.equal(canonicalCategoryName('Home and Office Cleaning'), 'Home & Office Cleaning');
  assert.equal(canonicalCategoryName('Repair & Maintenance'), 'Other Services');
  assert.equal(canonicalCategoryName('Custom Local Skill'), 'Custom Local Skill');
  assert.equal(new Set(DEFAULT_SERVICE_CATEGORIES.map(categoryConceptKey)).size, DEFAULT_SERVICE_CATEGORIES.length);
  for (const category of SERVICE_CATEGORY_CATALOG) {
    assert.ok(category.examples.length > 10);
    assert.equal(officialCategoryForName(category.name)?.name, category.name);
    for (const alias of category.aliases) assert.equal(canonicalCategoryName(alias), category.name);
  }
});

test('laptop repair belongs to computers, electrical work stays distinct, and fallback retains content safeguards', () => {
  const laptop = { kind: 'SERVICE_LISTING' as const, title: 'Laptop repair and diagnostics', description: 'Diagnose and repair laptop motherboard faults.' };
  assert.equal(assessMarketplaceContent({ ...laptop, categoryName: 'Computer & Laptop Repair' }).outcome, 'PASS');
  for (const categoryName of ['Electrical Wiring & Repairs', 'Electrical Repair']) {
    assert.equal(assessMarketplaceContent({ ...laptop, categoryName }).reasonCode, 'CATEGORY_MISMATCH');
  }
  assert.equal(assessMarketplaceContent({ ...laptop, categoryName: 'Other Services' }).outcome, 'PASS');
  assert.equal(assessMarketplaceContent({ ...laptop, categoryName: 'Other Services', title: 'Sell firearms' }).reasonCode, 'PROHIBITED_SERVICE');
});

test('legacy category filters query the same canonical family on both marketplace reads', async t => {
  const listingQueries: any[] = [], requestQueries: any[] = [];
  const singleton = globalThis as unknown as { prisma?: PrismaClient };
  const previous = singleton.prisma;
  singleton.prisma = {
    service: { findMany: async (query: any) => { listingQueries.push(query); return []; } },
    serviceRequest: { findMany: async (query: any) => { requestQueries.push(query); return []; } },
  } as unknown as PrismaClient;
  t.after(() => { singleton.prisma = previous; });
  const { browseServices } = await import('../services/services.service');
  const { listRequests } = await import('../services/requests.service');
  await browseServices({ categoryName:'Computer / IT Services' });
  await listRequests(undefined, undefined, { latitude:10.3, longitude:123.9, radiusKm:2, category:'House Cleaning' });
  assert.deepEqual(listingQueries[0].where.category, { name:{ equals:'Computer & Laptop Repair', mode:'insensitive' } });
  assert.deepEqual(requestQueries[0].where.category, { name:{ equals:'Home & Office Cleaning', mode:'insensitive' } });
});
