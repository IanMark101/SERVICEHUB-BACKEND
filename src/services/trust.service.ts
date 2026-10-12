import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { toPublicTrustEvent } from "../lib/public-trust-history";

type TrustEventInput = {
  userId: string;
  delta: number;
  reason: string;
  eventKey: string;
  actorAdminId?: string;
  requestedDelta?: number;
  bookingId?: string;
  category?: string;
  penaltyKey?: string;
  reversesEventId?: string;
};

/** The only function allowed to mutate User.trustScore. */
export async function applyTrustEventInTransaction(tx: Prisma.TransactionClient, input: TrustEventInput) {
  // Serialize trust changes without hard-coding a table schema into raw SQL.
  // This remains correct for isolated test schemas and multi-schema deploys.
  await tx.$queryRaw<Array<{ lock: string }>>`
    SELECT pg_advisory_xact_lock(hashtext(${`trust:${input.userId}`}))::text AS "lock"
  `;
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { trustScore: true },
  });
  if (!user) {
    const error = new Error("User not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  const scoreBefore = user.trustScore;
  // Check after acquiring the user lock so a concurrent retry sees the committed event.
  const existing = await tx.trustScoreEvent.findUnique({ where: { eventKey: input.eventKey }, select: { id: true, userId: true, reason: true, actorAdminId: true, requestedDelta: true, reversesEventId: true } });
  if (existing) {
    if (input.requestedDelta !== undefined &&
      (existing.userId !== input.userId || existing.reason !== input.reason ||
        existing.actorAdminId !== input.actorAdminId || existing.requestedDelta !== input.requestedDelta ||
        (input.reversesEventId !== undefined && existing.reversesEventId !== input.reversesEventId))) {
      const error = new Error("Trust adjustment operation ID was already used with different details") as Error & { status?: number; code?: string };
      error.status = 409;
      error.code = "TRUST_OPERATION_CONFLICT";
      throw error;
    }
    return { applied: false };
  }
  const scoreAfter = Math.min(100, Math.max(0, scoreBefore + input.delta));
  await tx.user.update({ where: { id: input.userId }, data: { trustScore: scoreAfter } });
  await tx.trustScoreEvent.create({
    data: {
      userId: input.userId,
      delta: scoreAfter - scoreBefore,
      requestedDelta: input.requestedDelta ?? input.delta,
      reason: input.reason,
      scoreBefore,
      scoreAfter,
      actorAdminId: input.actorAdminId,
      eventKey: input.eventKey,
      bookingId: input.bookingId,
      category: input.category,
      penaltyKey: input.penaltyKey,
      reversesEventId: input.reversesEventId,
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
  await applyTrustEvent(userId, 5, "Residency & Identity Verification Approved by Admin", actorAdminId, `verification-approval:${userId}`);
}

export async function applyManualTrustAdjustment(input: {
  userId: string;
  adminId: string;
  eventId: string;
  reason: string;
  operationId: string;
}) {
  if (input.adminId === input.userId || input.reason.trim().length < 20) throw Object.assign(new Error('A correction requires an independent administrator and a documented reason'), { status: 422 });
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`trust:${input.userId}`}))::text`;
    const original = await tx.trustScoreEvent.findUnique({ where: { id: input.eventId } });
    if (!original || original.userId !== input.userId || original.delta === 0 ||
      original.reversesEventId || ['POLICY_TRANSITION', 'LEGACY_DUPLICATE_PENALTY', 'REVIEW_LEGACY'].includes(original.category) ||
      original.eventKey?.startsWith('account-baseline:') || original.eventKey?.startsWith('review:')) {
      throw Object.assign(new Error('Select an eligible original trust event to correct'), { status: 422 });
    }
    const reversal = await tx.trustScoreEvent.findUnique({ where: { reversesEventId: original.id } });
    if (reversal && reversal.eventKey !== `manual-trust:${input.adminId}:${input.operationId}`) {
      throw Object.assign(new Error('This trust event has already been corrected'), { status: 409 });
    }
    const result = await applyTrustEventInTransaction(tx, {
      userId: input.userId,
      delta: -original.delta,
      requestedDelta: -original.delta,
      reason: input.reason,
      actorAdminId: input.adminId,
      eventKey: `manual-trust:${input.adminId}:${input.operationId}`,
      reversesEventId: original.id,
      bookingId: original.bookingId ?? undefined,
      category: 'CORRECTION',
    });
    if (result.applied) await tx.notification.create({ data: { userId: input.userId, title: "Trust score adjusted", body: `An administrator adjusted your trust score to ${result.scoreAfter}. Reason: ${input.reason}` } });
    return result;
  });
}

export async function getTrustHistory(userId: string) {
  const events = await prisma.trustScoreEvent.findMany({ where: { userId }, include: { reversal: { select: { id: true } }, trustCases: { select: { id: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return events.map(({ reversal, trustCases, ...event }) => ({ ...event,
    appealable: ['REPORT_PENALTY', 'CANCELLATION_PENALTY'].includes(event.category) && !reversal && !trustCases.length }));
}

export async function getPublicTrustHistory(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  const events = await prisma.trustScoreEvent.findMany({
    where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, delta: true, reason: true, scoreBefore: true, scoreAfter: true, createdAt: true, eventKey: true },
  });
  return events.map(toPublicTrustEvent);
}
