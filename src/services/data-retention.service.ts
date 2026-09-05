import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

const NONTERMINAL_BOOKING_STATUSES = [
  "PENDING_APPROVAL",
  "WAITING",
  "ACCEPTED",
  "ONGOING",
  "AWAITING_CONFIRMATION",
  "UNDER_REVIEW",
  "DISPUTED",
] as const;

export async function getUserActiveCaseCounts(tx: Prisma.TransactionClient, userId: string) {
  const bookingScope = { OR: [{ seekerId: userId }, { providerId: userId }] };
  const bookingIds = (await tx.booking.findMany({ where: bookingScope, select: { id: true } })).map((item) => item.id);
  const [nonterminalBookings, heldPayments, cancellations, reports, completionEscalations] = await Promise.all([
    tx.booking.count({ where: { ...bookingScope, status: { in: [...NONTERMINAL_BOOKING_STATUSES] } } }),
    tx.booking.count({ where: { ...bookingScope, paymentStatus: { in: ["PAID_HELD", "FROZEN_HELD"] } } }),
    tx.cancellationRequest.count({
      where: { bookingId: { in: bookingIds }, status: { in: ["PENDING", "ESCALATED"] } },
    }),
    tx.report.count({
      where: {
        OR: [{ reporterId: userId }, { reportedUserId: userId }],
        status: { in: ["PENDING", "UNDER_REVIEW"] },
      },
    }),
    tx.completionEscalation.count({
      where: { bookingId: { in: bookingIds }, status: { in: ["PENDING", "UNDER_REVIEW"] } },
    }),
  ]);
  return { nonterminalBookings, heldPayments, cancellations, reports, completionEscalations };
}

export async function getVerificationRetentionState(verificationId: string) {
  return prisma.$transaction(async (tx) => {
    const verification = await tx.serviceVerification.findUnique({
      where: { id: verificationId },
      select: { userId: true, retentionUntil: true, legalHold: true },
    });
    if (!verification) return null;
    const activeCases = await getUserActiveCaseCounts(tx, verification.userId);
    const hasActiveCaseHold = Object.values(activeCases).some((count) => count > 0);
    return {
      retentionUntil: verification.retentionUntil,
      legalHold: verification.legalHold,
      hasActiveCaseHold,
      canPurge: verification.retentionUntil <= new Date() && !verification.legalHold && !hasActiveCaseHold,
    };
  });
}
