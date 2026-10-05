import type { Prisma } from '@prisma/client';

/** Called only after the winning offer is committed inside the request lock. */
export async function rejectSiblingOffersAndNotify(
  tx: Prisma.TransactionClient,
  requestId: string,
  selectedOfferId: string,
  requestTitle: string,
) {
  const siblings = await tx.offer.findMany({
    where: { requestId, id: { not: selectedOfferId }, status: 'PENDING' },
    select: { id: true, providerId: true },
  });
  if (siblings.length === 0) return [] as string[];

  const rejected = [] as typeof siblings;
  for (const sibling of siblings) {
    const changed = await tx.offer.updateMany({
      where: { id: sibling.id, status: 'PENDING' },
      data: { status: 'REJECTED', paymentHoldExpiresAt: null },
    });
    if (changed.count === 1) rejected.push(sibling);
  }
  if (rejected.length === 0) return [] as string[];
  await tx.notification.createMany({
    data: rejected.map((offer) => ({
      id: `offer-not-selected:${offer.id}`,
      userId: offer.providerId,
      title: 'Another offer was selected',
      body: `Another offer was selected for "${requestTitle}". Thank you for responding to this request.`,
      link: `/provider/provider-activity?tab=all&offer=${encodeURIComponent(offer.id)}`,
    })),
    skipDuplicates: true,
  });
  return [...new Set(rejected.map((offer) => offer.providerId))];
}
