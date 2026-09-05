import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { CreateServiceSchema, UpdateServiceSchema } from "../schema/services.schema";
import { createService, updateService, deleteService, toggleServiceAvailability } from "../services/services.service";
import { applyTrustEvent } from "../services/trust.service";
import { summarizeProviderReviews, invalidateProviderSummary } from "../services/ai.service";
import { env } from "../config/env";
import { getUserPublicProfile } from "../services/auth/profile.service";
import { getUserTrustHistoryHandler } from "../controllers/auth.controller";

test("listing concurrency, material edits, custom pricing and trust retries", async (t) => {
  const suffix = randomUUID();
  const provider = await prisma.user.create({ data: {
    name: `Listing Test ${suffix}`, email: `${suffix}@example.test`, passwordHash: "test-only-unusable-hash",
    phone: "test-only", location: "Cordova", emailVerified: true, verificationStatus: "APPROVED",
  } });
  const category = await prisma.category.create({ data: { name: `Listing Test ${suffix}` } });
  const seeker = await prisma.user.create({ data: { name: `Seeker Test ${suffix}`, email: `seeker-${suffix}@example.test`, passwordHash: 'test-only', phone: 'test-only', location: 'Cordova' } });
  t.after(async () => {
    await prisma.aiReviewSummary.deleteMany({ where: { providerId: provider.id } });
    await prisma.review.deleteMany({ where: { targetId: provider.id } });
    await prisma.completedService.deleteMany({ where: { OR: [{ providerId: provider.id }, { seekerId: provider.id }] } });
    await prisma.booking.deleteMany({ where: { OR: [{ providerId: provider.id }, { seekerId: provider.id }] } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: provider.id }, { body: { contains: suffix } }] } });
    await prisma.service.deleteMany({ where: { providerId: provider.id } });
    await prisma.user.delete({ where: { id: provider.id } });
    await prisma.user.delete({ where: { id: seeker.id } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.$disconnect();
  });
  const input = (title: string) => CreateServiceSchema.parse({ categoryId: category.id, title,
    description: "A sufficiently detailed test description for a provider listing.", price: 500,
    estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true } });
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => createService(provider.id, input(`Listing ${index} ${suffix}`))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
  const first = results.find((result) => result.status === "fulfilled");
  assert.ok(first?.status === "fulfilled");
  const listing = first.value;
  await prisma.service.update({ where: { id: listing.id }, data: { status: "ACTIVE", isAvailable: true } });
  assert.equal((await toggleServiceAvailability(listing.id, provider.id)).status, 'INACTIVE');
  assert.equal((await toggleServiceAvailability(listing.id, provider.id)).status, 'ACTIVE');
  const edited = await updateService(listing.id, provider.id, { description: "This changed description must be moderated before it becomes public." });
  assert.equal(edited.status, "PENDING_REVIEW");
  assert.equal(edited.isAvailable, false);
  const custom = await updateService(listing.id, provider.id, { priceType: "CUSTOM" });
  assert.equal(custom.price, null);
  await assert.rejects(updateService(listing.id, provider.id, { priceType: "FIXED" }));
  assert.equal(UpdateServiceSchema.safeParse({ paymentMethods: { cash: false, gcash: false, maya: false, card: false } }).success, false);
  await deleteService(listing.id, provider.id);
  const reused = await createService(provider.id, input(listing.title.toUpperCase()));
  assert.notEqual(reused.id, listing.id);
  const active = await prisma.service.findMany({ where: { providerId: provider.id, status: "PENDING_REVIEW" } });
  await assert.rejects(updateService(active.find((item) => item.id !== reused.id)!.id, provider.id, { title: `  ${reused.title.toLowerCase()}  ` }));
  const scoreBefore = (await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).trustScore;
  await Promise.all(Array.from({ length: 3 }, () => applyTrustEvent(provider.id, 3, "Duplicate business event test", undefined, `phase5:${suffix}`)));
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).trustScore, scoreBefore + 3);
  assert.equal(await prisma.trustScoreEvent.count({ where: { eventKey: `phase5:${suffix}` } }), 1);

  const savedKey = env.GEMINI_API_KEY;
  const savedFetch = globalThis.fetch;
  let geminiCalls = 0;
  env.GEMINI_API_KEY = 'mock-key-used-only-with-intercepted-fetch';
  globalThis.fetch = async () => {
    geminiCalls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Test-generated summary.' }] } }] }), { status: 200 });
  };
  try {
    const addReview = async () => {
      const booking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: reused.id,
        originType: 'DIRECT_LISTING', paymentMethod: 'On-site Cash', agreedAmount: 500, status: 'COMPLETED', paymentStatus: 'CASH_CONFIRMED', started: true } });
      const completed = await prisma.completedService.create({ data: { bookingId: booking.id, seekerId: seeker.id, providerId: provider.id, finalPrice: 500, paymentStatus: 'CASH_CONFIRMED' } });
      return prisma.review.create({ data: { completedServiceId: completed.id, authorId: seeker.id, targetId: provider.id, rating: 5, text: 'The repair was completed carefully and clearly explained.', editableUntil: new Date() } });
    };
    for (let index = 0; index < 4; index++) await addReview();
    assert.equal((await summarizeProviderReviews(provider.id)).source, 'computed');
    assert.equal(geminiCalls, 0);
    const fifth = await addReview();
    assert.equal((await summarizeProviderReviews(provider.id)).source, 'gemini');
    assert.equal(geminiCalls, 1);
    const reverseBooking = await prisma.booking.create({ data: { seekerId: provider.id, providerId: seeker.id,
      originType: 'DIRECT_LISTING', paymentMethod: 'On-site Cash', agreedAmount: 500, status: 'COMPLETED', paymentStatus: 'CASH_CONFIRMED', started: true } });
    const reverseCompleted = await prisma.completedService.create({ data: { bookingId: reverseBooking.id, seekerId: provider.id,
      providerId: seeker.id, finalPrice: 500, paymentStatus: 'CASH_CONFIRMED' } });
    await prisma.review.create({ data: { completedServiceId: reverseCompleted.id, authorId: seeker.id, targetId: provider.id,
      rating: 1, text: 'Feedback about the account acting as a seeker.', editableUntil: new Date() } });
    const profile = await getUserPublicProfile(provider.id);
    assert.equal(profile.averageRating, 5);
    assert.equal(profile.reviews.some((review) => review.reviewContext === 'SEEKER'), true);
    let status = 200;
    await getUserTrustHistoryHandler({ params: { id: provider.id }, user: { id: seeker.id, role: 'user' } } as any,
      { status(code: number) { status = code; return this; }, json() {} } as any,
      (error) => { if (error) throw error; });
    assert.equal(status, 403);
    invalidateProviderSummary(provider.id);
    assert.equal((await summarizeProviderReviews(provider.id)).cached, true);
    assert.equal(geminiCalls, 1);
    await prisma.review.update({ where: { id: fifth.id }, data: { visibility: 'HIDDEN' } });
    assert.equal((await summarizeProviderReviews(provider.id)).source, 'computed');
    assert.equal(geminiCalls, 1);
  } finally {
    env.GEMINI_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
  }
});
