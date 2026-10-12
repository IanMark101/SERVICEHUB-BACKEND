import type { Prisma } from '@prisma/client';
import { applyTrustEventInTransaction } from './trust.service';

export const TRUST_PAIR_WINDOW_DAYS = 30;
const failure = (message: string, status = 422) => Object.assign(new Error(message), { status });

/** Caller holds the booking lifecycle lock. Pair locking prevents simultaneous
 * completions in either role from bypassing the rolling reward limit. */
export async function awardBookingCompletionTrust(tx: Prisma.TransactionClient, bookingId: string) {
  const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: {
    completedService: true,
    provider: { select: { verificationStatus: true, isActive: true, moderationStatus: true } },
    seeker: { select: { verificationStatus: true, isActive: true, moderationStatus: true } },
  } });
  if (!booking || booking.status !== 'COMPLETED' || !booking.completedService ||
    !['CASH_CONFIRMED', 'RELEASED'].includes(booking.paymentStatus) ||
    booking.providerId === booking.seekerId || booking.provider.verificationStatus !== 'APPROVED' ||
    booking.seeker.verificationStatus !== 'APPROVED') return;
  const pending = await tx.report.count({ where: { bookingId, status: { in: ['PENDING', 'UNDER_REVIEW'] } } }) +
    await tx.cancellationRequest.count({ where: { bookingId, status: { in: ['PENDING', 'ESCALATED', 'UNDER_REVIEW'] } } }) +
    await tx.completionEscalation.count({ where: { bookingId, status: { in: ['PENDING', 'UNDER_REVIEW'] } } });
  if (pending) return;
  const ids = [booking.providerId, booking.seekerId].sort();
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`trust-pair:${ids.join(':')}`}))::text`;
  // Existing events count even when clamped to zero at 100 points.
  const recent = await tx.trustScoreEvent.findFirst({ where: {
    category: 'COMPLETION', bookingId: { not: bookingId }, reversal: null,
    createdAt: { gt: new Date(Date.now() - TRUST_PAIR_WINDOW_DAYS * 86400000) },
    userId: { in: ids },
    booking: { OR: [
      { providerId: ids[0], seekerId: ids[1] }, { providerId: ids[1], seekerId: ids[0] },
    ] },
  } });
  if (recent) return;
  for (const userId of ids) {
    const account = userId === booking.providerId ? booking.provider : booking.seeker;
    if (!account.isActive || account.moderationStatus !== 'ACTIVE') continue;
    const fault = await tx.trustScoreEvent.findFirst({ where: { bookingId, userId, category: { in: ['REPORT_PENALTY', 'CANCELLATION_PENALTY'] },
      reversal: null } });
    if (fault) continue;
    await applyTrustEventInTransaction(tx, { userId, delta: 3, bookingId, category: 'COMPLETION',
      reason: 'Eligible booking completed and payment settled',
      eventKey: `booking-completion:${bookingId}:${userId === booking.providerId ? 'provider' : 'seeker'}` });
  }
}

export async function applyBookingTrustPenalty(tx: Prisma.TransactionClient, input: {
  bookingId: string; userId: string; adminId: string; eventKey: string;
  category: 'REPORT_PENALTY' | 'CANCELLATION_PENALTY'; reason: string;
}) {
  if (input.reason.trim().length < 20) throw failure('Describe the violated rule and supporting booking evidence (at least 20 characters)');
  const booking = await tx.booking.findUnique({ where: { id: input.bookingId }, select: { seekerId: true, providerId: true, started: true } });
  if (!booking || ![booking.providerId, booking.seekerId].includes(input.userId)) throw failure('Trust penalties require a booking participant');
  if ([booking.providerId, booking.seekerId].includes(input.adminId)) throw failure('An administrator cannot decide a booking they participated in', 403);
  if (input.category === 'CANCELLATION_PENALTY' && !booking.started) throw failure('Cancellation penalties apply only after work starts');
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`trust:${input.userId}`}))::text`;
  const penaltyKey = `booking-penalty:${input.bookingId}:${input.userId}`;
  if (await tx.trustScoreEvent.findUnique({ where: { penaltyKey } })) return { applied: false };
  const result = await applyTrustEventInTransaction(tx, { userId: input.userId,
    delta: input.category === 'CANCELLATION_PENALTY' ? -5 : -10, reason: input.reason,
    actorAdminId: input.adminId, bookingId: input.bookingId, category: input.category,
    eventKey: input.eventKey, penaltyKey });
  if (result.applied) await tx.notification.create({ data: { userId: input.userId,
    title: 'Trust penalty recorded', body: `${input.reason} View Trust History to appeal this finding.`,
    link: '/seeker/user-profile?tab=trust' } });
  return result;
}
