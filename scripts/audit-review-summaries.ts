import { prisma } from '../src/lib/prisma';

// Read-only audit: public review facts only; no model calls or cache writes.
async function main() {
  const reviews = await prisma.review.findMany({
    select: { id: true, authorId: true, targetId: true, rating: true, tags: true,
      visibility: true, text: true,
      target: { select: { name: true } },
      completedService: { select: { providerId: true, seekerId: true, booking: { select: { status: true } } } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const groups = new Map<string, typeof reviews>();
  let invalidParticipants = 0;
  for (const review of reviews) {
    const cs = review.completedService;
    const role = review.targetId === cs.providerId && review.authorId === cs.seekerId ? 'provider'
      : review.targetId === cs.seekerId && review.authorId === cs.providerId ? 'seeker' : null;
    if (!role) { invalidParticipants++; continue; }
    if (review.visibility !== 'VISIBLE') continue;
    const key = `${role}:${review.targetId}`;
    groups.set(key, [...(groups.get(key) ?? []), review]);
  }
  const persisted = await prisma.aiReviewSummary.findMany({ select: { providerId: true, source: true, reviewCount: true, summary: true } });
  console.log(JSON.stringify({ totalReviews: reviews.length, invalidParticipants, groups: [...groups].map(([key, list]) => ({
    role: key.split(':')[0], user: list[0].target.name, reviewCount: list.length,
    latest20Average: Number((list.slice(0, 20).reduce((sum, r) => sum + r.rating, 0) / Math.min(20, list.length)).toFixed(1)),
    reviews: list.slice(0, 20).map(r => ({ rating: r.rating, tags: r.tags, hasWrittenFeedback: !!r.text?.trim(), bookingStatus: r.completedService.booking?.status ?? 'legacy completed-service anchor' })),
    persisted: key.startsWith('provider:') ? persisted.find(r => r.providerId === list[0].targetId) ?? null : undefined,
  })) }, null, 2));
}
main().finally(() => prisma.$disconnect());
