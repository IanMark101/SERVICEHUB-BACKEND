import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';

test('saved request details respect membership without trapping bookmarks or enrolling readers', async t => {
  const active = {
    id: 'provider', role: 'user', isActive: true, moderationStatus: 'ACTIVE', deactivatedAt: null,
    subscriptionPlan: 'FREE', subscriptionStatus: 'ACTIVE', subscriptionStartedAt: null as Date | null,
    subscriptionExpiresAt: null as Date | null, freePlanStartedAt: new Date(Date.now() - 10 * 86400000) as Date | null,
    freePlanExpiresAt: new Date(Date.now() + 20 * 86400000) as Date | null,
  };
  const expired = { ...active, freePlanExpiresAt: new Date(Date.now() - 1) };
  const request = { id: 'open', seekerId: 'customer', targetServiceId: null, targetProviderId: null,
    title: 'Laptop repair request', description: 'Inspect and repair my laptop.', status: 'OPEN', archivedAt: null,
    photos: [], _count: { offers: 0 }, seeker: { id: 'customer', name: 'Customer' },
    latitude: 10, longitude: 123, privateAddress: 'Private address' };
  let membership = { ...active };
  let membershipReads = 0, contentReads = 0, enrollments = 0;
  let expireAfterSummary = false, contentFailure = false;
  let bookmarks: { id: string; requestId: string; serviceId: null; createdAt: Date }[] = [];
  const reset = () => {
    membership = { ...active }; membershipReads = contentReads = enrollments = 0;
    expireAfterSummary = contentFailure = false;
    bookmarks = ['open', 'closed'].map(id => ({ id: `saved-${id}`, requestId: id, serviceId: null, createdAt: new Date() }));
  };
  reset();
  const fake = {
    $executeRaw: async () => 0, $queryRaw: async () => [],
    user: {
      findUnique: async () => membership,
      findUniqueOrThrow: async () => {
        membershipReads++;
        const current = membership;
        if (expireAfterSummary && membershipReads === 1) membership = { ...expired };
        return current;
      },
      update: async () => { enrollments++; throw new Error('A saved read must not enroll a trial.'); },
    },
    serviceRequest: {
      count: async () => 0,
      findUnique: async () => request,
      findFirst: async () => request,
      findMany: async () => { contentReads++; if (contentFailure) throw new Error('Request storage unavailable.'); return [request]; },
    },
    savedListing: {
      count: async () => bookmarks.length,
      findMany: async () => bookmarks,
      deleteMany: async ({ where }: { where: { requestId: string } }) => {
        bookmarks = bookmarks.filter(row => row.requestId !== where.requestId); return { count: 1 };
      },
      upsert: async () => { throw new Error('Expired accounts must not save new requests.'); },
    },
  };
  const singleton = globalThis as unknown as { prisma?: PrismaClient };
  const previous = singleton.prisma;
  singleton.prisma = { ...fake, $transaction: async (run: (tx: typeof fake) => unknown) => run(fake) } as unknown as PrismaClient;
  t.after(() => { singleton.prisma = previous; });
  const { getSavedListings, saveListing, unsaveListing } = await import('../services/saved-listings.service');

  await t.test('active access hydrates visible requests and keeps unavailable bookmarks removable', async () => {
    reset();
    const saved = await getSavedListings('provider', 'SERVICE_REQUEST', 1, 12);
    assert.equal(saved.items.find(item => item.listingId === 'open')?.listing?.title, request.title);
    assert.equal(saved.items.find(item => item.listingId === 'closed')?.listing, null);
    assert.equal(saved.pagination.total, 2);
    assert.ok(membershipReads >= 2, 'Both summary and request authorization must check membership.');
    assert.equal(enrollments, 0);
    assert.ok(!JSON.stringify(saved).includes('Private address'));
    assert.equal('latitude' in saved.items.find(item => item.listingId === 'open')!.listing!, false);
  });
  for (const plan of ['FREE', 'BASIC', 'PRO']) await t.test(`expired ${plan} hides details but retains removal`, async () => {
    reset(); membership = { ...expired, subscriptionPlan: plan, subscriptionStatus: 'EXPIRED',
      subscriptionStartedAt: new Date(Date.now() - 30 * 86400000), subscriptionExpiresAt: new Date(Date.now() - 1) };
    const saved = await getSavedListings('provider', 'SERVICE_REQUEST', 1, 12);
    assert.equal(saved.items.length, 2); assert.ok(saved.items.every(item => item.listing === null));
    assert.equal(contentReads, 0); assert.equal(enrollments, 0);
    await assert.rejects(saveListing('provider', 'SERVICE_REQUEST', 'open'), error => (error as { code?: string }).code === 'PROVIDER_MEMBERSHIP_EXPIRED');
    await unsaveListing('provider', 'SERVICE_REQUEST', 'open');
    await unsaveListing('provider', 'SERVICE_REQUEST', 'open');
    assert.equal((await getSavedListings('provider', 'SERVICE_REQUEST', 1, 12)).items.length, 1);
  });
  await t.test('unenrolled readers cannot hydrate requests or start their trial by reading Saved', async () => {
    reset(); membership = { ...active, freePlanStartedAt: null, freePlanExpiresAt: null };
    const saved = await getSavedListings('provider', 'SERVICE_REQUEST', 1, 12);
    assert.ok(saved.items.every(item => item.listing === null));
    assert.equal(contentReads, 0); assert.equal(enrollments, 0);
  });
  await t.test('expiry between the two reads hides details while retaining bookmarks', async () => {
    reset(); expireAfterSummary = true;
    const saved = await getSavedListings('provider', 'SERVICE_REQUEST', 1, 12);
    assert.ok(saved.items.every(item => item.listing === null));
    assert.equal(contentReads, 0);
  });
  await t.test('other storage errors remain visible and empty Saved never enrolls', async () => {
    reset(); contentFailure = true;
    await assert.rejects(getSavedListings('provider', 'SERVICE_REQUEST', 1, 12), /Request storage unavailable/);
    reset(); bookmarks = [];
    assert.equal((await getSavedListings('provider', 'SERVICE_REQUEST', 1, 12)).items.length, 0);
    assert.equal(membershipReads, 0); assert.equal(enrollments, 0);
  });
});
