import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export const NONTERMINAL_BOOKING_STATUSES = [
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
  // Interactive transactions own one PostgreSQL client. Keep these queries
  // sequential so the driver never receives overlapping work on that client.
  const nonterminalBookings = await tx.booking.count({
    where: { ...bookingScope, status: { in: [...NONTERMINAL_BOOKING_STATUSES] } },
  });
  const heldPayments = await tx.booking.count({
    where: { ...bookingScope, paymentStatus: { in: ["PAID_HELD", "FROZEN_HELD"] } },
  });
  const cancellations = await tx.cancellationRequest.count({
    where: { bookingId: { in: bookingIds }, OR: [
      { status: { in: ["PENDING", "ESCALATED", "UNDER_REVIEW"] } },
      { status: "DECLINED", booking: { status: { in: [...NONTERMINAL_BOOKING_STATUSES] } } },
    ] },
  });
  const reports = await tx.report.count({
    where: {
      OR: [{ reporterId: userId }, { reportedUserId: userId }],
      status: { in: ["PENDING", "UNDER_REVIEW"] },
    },
  });
  const completionEscalations = await tx.completionEscalation.count({
    where: { bookingId: { in: bookingIds }, status: { in: ["PENDING", "UNDER_REVIEW"] } },
  });
  const paymentAttempts = await tx.paymentAttempt.count({
    where: { OR: [{ seekerId: userId }, { providerId: userId }], status: { in: ["PENDING", "REFUND_REQUIRED"] } },
  });
  const unresolvedRefunds = await tx.paymentRefund.count({
    where: { bookingId: { in: bookingIds }, status: { in: ["PROCESSING", "FAILED"] } },
  });
  const banAppeals = await tx.banAppeal.count({ where: { userId, status: "PENDING" } });
  return { nonterminalBookings, heldPayments, cancellations, reports, completionEscalations, paymentAttempts, unresolvedRefunds, banAppeals };
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
