import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

type TrustEventInput = {
  userId: string;
  delta: number;
  reason: string;
  eventKey: string;
  actorAdminId?: string;
};

/** The only function allowed to mutate User.trustScore. */
export async function applyTrustEventInTransaction(tx: Prisma.TransactionClient, input: TrustEventInput) {
  const users = await tx.$queryRaw<Array<{ trustScore: number }>>`
    SELECT "trustScore" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE
  `;
  const user = users[0];
  if (!user) {
    const error = new Error("User not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  const scoreBefore = user.trustScore;
  // Check after acquiring the user lock so a concurrent retry sees the committed event.
  const existing = await tx.trustScoreEvent.findUnique({ where: { eventKey: input.eventKey }, select: { id: true } });
  if (existing) return { applied: false };
  const scoreAfter = Math.min(100, Math.max(0, scoreBefore + input.delta));
  await tx.user.update({ where: { id: input.userId }, data: { trustScore: scoreAfter } });
  await tx.trustScoreEvent.create({
    data: {
      userId: input.userId,
      delta: scoreAfter - scoreBefore,
      reason: input.reason,
      scoreBefore,
      scoreAfter,
      actorAdminId: input.actorAdminId,
      eventKey: input.eventKey,
    },
  });
  if (input.actorAdminId) {
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actorAdminId,
        targetUserId: input.userId,
        action: "TRUST_SCORE_ADJUSTED",
        resourceType: "User",
        resourceId: input.userId,
        reason: input.reason,
        metadata: { requestedDelta: input.delta, scoreBefore, scoreAfter, eventKey: input.eventKey },
      },
    });
  }
  return { applied: true, scoreBefore, scoreAfter };
}

export async function applyTrustEvent(
  userId: string,
  delta: number,
  reason: string,
  actorAdminId?: string,
  eventKey = `trust-operation:${randomUUID()}`,
): Promise<void> {
  await prisma.$transaction((tx) => applyTrustEventInTransaction(tx, { userId, delta, reason, actorAdminId, eventKey }));
}

export async function recordAccountCreationBaseline(userId: string): Promise<void> {
  await prisma.trustScoreEvent.upsert({
    where: { eventKey: `account-baseline:${userId}` }, update: {},
    create: { userId, delta: 50, reason: "Initial Account Base Trust Score Baseline", scoreBefore: 0, scoreAfter: 50, eventKey: `account-baseline:${userId}` },
  });
}

export async function applyVerificationApprovalTrust(userId: string, actorAdminId?: string, verificationId = userId): Promise<void> {
  await applyTrustEvent(userId, 5, "Residency & Identity Verification Approved by Cordova Admin", actorAdminId, `verification-approval:${verificationId}`);
}

export async function applyServiceCompletionTrust(userId: string, bookingId = randomUUID()): Promise<void> {
  await applyTrustEvent(userId, 3, "Service completed & confirmed by seeker", undefined, `booking-completion:${bookingId}:provider`);
}

export function reviewTrustDelta(rating: number) {
  if (rating === 5) return 2;
  if (rating === 4) return 1;
  if (rating === 2) return -3;
  if (rating === 1) return -5;
  return 0;
}

export async function applyReviewTrust(userId: string, rating: number, reviewId = randomUUID()): Promise<void> {
  const delta = reviewTrustDelta(rating);
  if (delta) await applyTrustEvent(userId, delta, `Received ${rating}-star provider review`, undefined, `review:${reviewId}:rating:v1`);
}

export async function applyCancellationTrust(userId: string, isProvider: boolean, cancellationId = randomUUID()): Promise<void> {
  const role = isProvider ? "Provider" : "Seeker";
  await applyTrustEvent(userId, -5, `${role} cancelled active booking (at fault)`, undefined, `cancellation:${cancellationId}:${userId}`);
}

export async function applyReportPenaltyTrust(userId: string, actorAdminId?: string, reportId = randomUUID()): Promise<void> {
  await applyTrustEvent(userId, -10, "Valid report filed and confirmed by admin", actorAdminId, `report:${reportId}:penalty`);
}

export async function applyListingRejectionTrust(userId: string, rejectionCount: number, serviceId = randomUUID()): Promise<void> {
  if (rejectionCount === 2) {
    await applyTrustEvent(userId, -5, "Second repeated service listing rejection", undefined, `listing-rejection:${serviceId}:2`);
  }
}

export async function getTrustHistory(userId: string) {
  return prisma.trustScoreEvent.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}
