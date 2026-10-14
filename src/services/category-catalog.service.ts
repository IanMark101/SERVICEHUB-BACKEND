import { prisma } from '../lib/prisma';
import { DEFAULT_SERVICE_CATEGORIES, categoryConceptKey, isFallbackCategory } from '../lib/category-catalog';

/** Add defaults without renaming legacy categories or undoing Admin decisions.
 * Only the system fallback is always kept active. Repeated seeds are harmless. */
export async function ensureDefaultServiceCategories() {
  return prisma.$transaction(async tx => {
    // Use the same name locks as Admin creation/rename, in a stable order.
    for (const name of [...DEFAULT_SERVICE_CATEGORIES].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${categoryConceptKey(name)}))`;
    }
    const existing = await tx.category.findMany({ orderBy: { name: 'asc' } });
    const names = new Set(existing.map(category => categoryConceptKey(category.name)));
    const missing = DEFAULT_SERVICE_CATEGORIES.filter(name => !names.has(categoryConceptKey(name)));
    if (missing.length) await tx.category.createMany({ data: missing.map(name => ({ name, isActive: true })) });
    const inactiveFallback = existing.find(category => isFallbackCategory(category.name) && !category.isActive);
    if (inactiveFallback) await tx.category.update({ where: { id: inactiveFallback.id }, data: { isActive: true } });
    return { added: missing, fallbackReactivated: Boolean(inactiveFallback), preservedExisting: existing.length };
  }, { timeout: 30_000 });
}
