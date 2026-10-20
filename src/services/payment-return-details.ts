import { prisma } from '../lib/prisma';
import { commissionResponse } from './payment-commission';
import type { getPaymentAttemptStatus } from './payment-attempt.service';

// Called only after reconciliation has verified the signed-in owner's attempt.
// Receipt restoration never depends on the browser retaining checkout storage.
export async function paymentReturnCheckout(seekerId: string, paymentIntentId: string,
  attempt: Awaited<ReturnType<typeof getPaymentAttemptStatus>>, db: Pick<typeof prisma, 'booking'> = prisma) {
  const booking = attempt.status === 'SUCCEEDED' ? await db.booking.findFirst({
    where: { paymentAttemptId: attempt.id, seekerId },
    select: { id: true, service: { select: { title: true } },
      offer: { select: { request: { select: { title: true } } } },
      provider: { select: { name: true } } },
  }) : null;
  return {
    seekerId, paymentIntentId,
    serviceId: attempt.serviceId ?? undefined, offerId: attempt.offerId ?? undefined,
    quantity: attempt.quantity,
    expectedAmount: Number(attempt.amount), commission: commissionResponse(attempt),
    isTestMode: attempt.isTestMode, paidAt: attempt.paidAt,
    reference: attempt.providerPaymentId ?? paymentIntentId,
    ...(booking && { bookingId: booking.id, title: booking.offer?.request.title ?? booking.service?.title,
      providerName: booking.provider.name }),
  };
}
