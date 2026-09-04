import type { BookingStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { safeEmit } from "../../lib/socket";
import { assertDistinctAccounts } from "../../utils/security";
import { sendMessage } from "../messages.service";
import { notifyWaitlist, recalculateQueue } from "../queue.service";

function httpError(message: string, status: number, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

export async function markJobComplete(id: string, providerId: string) {
  const result = await prisma.$transaction(async (tx) => {
    let booking = await tx.booking.findUnique({ where: { id }, include: { queue: true } });
    if (!booking) {
      const queue = await tx.queue.findUnique({ where: { id }, include: { booking: { include: { queue: true } } } });
      booking = queue?.booking || null;
    }
    if (!booking) throw httpError("Booking or queue entry not found", 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`completion:${booking.id}`}))`;
    const fresh = await tx.booking.findUnique({ where: { id: booking.id }, include: { queue: true } });
    if (!fresh || fresh.providerId !== providerId) throw httpError("Access denied", 403);
    if (fresh.status === "AWAITING_CONFIRMATION") return { booking: fresh, queue: fresh.queue, changed: false };
    if (fresh.status !== "ONGOING") throw httpError("Only an ongoing job can be marked complete", 409);

    const updated = await tx.booking.update({
      where: { id: fresh.id },
      data: { status: "AWAITING_CONFIRMATION" },
    });
    if (fresh.queue) {
      await tx.queue.update({ where: { id: fresh.queue.id }, data: { status: "DONE" } });
    }
    return { booking: updated, queue: fresh.queue, changed: true };
  });

  if (result.queue) {
    await recalculateQueue(result.queue.serviceId);
    await notifyWaitlist(result.queue.serviceId);
  }
  if (result.changed) {
    await prisma.notification.create({
      data: {
        userId: result.booking.seekerId,
        title: "Service marked complete",
        body: "Review the completed work, then confirm completion or open a dispute.",
        link: `/seeker/seeker-activity?tab=action_required&booking=${result.booking.id}`,
      },
    });
    safeEmit(`user:${result.booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: result.booking.id, type: "awaiting_confirmation" });
    safeEmit(`user:${result.booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: result.booking.id, type: "awaiting_confirmation" });
  }
  return result.booking;
}

export async function settleCompletedBooking(
  bookingId: string,
  actor: { type: "SEEKER"; userId: string } | { type: "ADMIN"; userId: string },
) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`completion:${bookingId}`}))`;
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { queue: true, offer: { select: { requestId: true } }, completedService: true },
    });
    if (!booking) throw httpError("Booking not found", 404);
    if (actor.type === "SEEKER" && booking.seekerId !== actor.userId) throw httpError("Access denied", 403);
    if (booking.status === "COMPLETED" && booking.completedService) return { completed: booking.completedService, booking, changed: false };
    const allowed = actor.type === "ADMIN"
      ? ["AWAITING_CONFIRMATION", "DISPUTED"].includes(booking.status)
      : booking.status === "AWAITING_CONFIRMATION";
    if (!allowed) throw httpError("This booking is not ready for completion settlement", 409);
    if (!booking.agreedAmount || Number(booking.agreedAmount) <= 0) throw httpError("Booking has no valid agreed amount", 409, "AGREED_AMOUNT_MISSING");

    const isCash = booking.paymentMethod === "On-site Cash";
    const settlementStatus = isCash ? "CASH_CONFIRMED" : "RELEASED";
    const completed = await tx.completedService.create({
      data: {
        bookingId: booking.id,
        queueId: booking.queue?.id || null,
        directRequestId: booking.directRequestId,
        offerId: booking.offerId,
        seekerId: booking.seekerId,
        providerId: booking.providerId,
        finalPrice: booking.agreedAmount,
        paymentStatus: settlementStatus,
      },
    });
    const updatedBooking = await tx.booking.update({
      where: { id: booking.id },
      data: { status: "COMPLETED", paymentStatus: settlementStatus, statusBeforeDispute: null },
    });
    if (booking.queue) {
      await tx.queue.update({ where: { id: booking.queue.id }, data: { status: "DONE", paymentStatus: settlementStatus } });
    }
    if (booking.offer?.requestId) {
      await tx.serviceRequest.update({ where: { id: booking.offer.requestId }, data: { status: "CLOSED" } });
    }

    // Only provider-collected online payments enter the internal wallet ledger.
    if (!isCash) {
      await tx.transaction.create({
        data: {
          walletOwnerId: booking.providerId,
          type: "EARNING",
          amount: booking.agreedAmount,
          relatedBookingId: completed.id,
          description: "Online payment released after completion confirmation",
          settlementSource: "ONLINE_LEDGER",
          idempotencyKey: `booking-completion:${booking.id}`,
        },
      });
    }

    const eventKey = `booking-completion:${booking.id}:provider`;
    const existingTrust = await tx.trustScoreEvent.findUnique({ where: { eventKey } });
    if (!existingTrust && booking.providerId !== booking.seekerId) {
      const provider = await tx.user.findUnique({ where: { id: booking.providerId }, select: { trustScore: true } });
      if (provider) {
        const nextScore = Math.min(100, provider.trustScore + 3);
        await tx.user.update({ where: { id: booking.providerId }, data: { trustScore: nextScore } });
        await tx.trustScoreEvent.create({
          data: { userId: booking.providerId, delta: nextScore - provider.trustScore, reason: "Service completed successfully", scoreBefore: provider.trustScore, scoreAfter: nextScore, eventKey },
        });
      }
    }
    return { completed, booking: updatedBooking, changed: true, isCash, queueServiceId: booking.queue?.serviceId };
  });

  if (result.changed) {
    try {
      await sendMessage(
        result.booking.id,
        actor.userId,
        result.isCash ? "Cash service completion confirmed." : "Online payment released after completion confirmation.",
        undefined,
        true,
        actor.type === "ADMIN" ? "admin" : undefined,
      );
      await prisma.notification.create({
        data: {
          userId: result.booking.providerId,
          title: "Completion confirmed",
          body: actor.type === "ADMIN"
            ? "An administrator resolved the dispute and confirmed completion."
            : result.isCash
              ? "The seeker confirmed completion of the on-site cash booking."
              : "The seeker confirmed completion and the internal payment hold was released.",
          link: `/provider/provider-activity?tab=all&booking=${result.booking.id}`,
        },
      });
    } catch (error) {
      // The booking settlement is already committed. A best-effort chat or
      // notification failure must not make the client retry financial state.
      console.error("Post-settlement notification failed", error);
    }
    safeEmit(`user:${result.booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: result.booking.id, type: "completed" });
    safeEmit(`user:${result.booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: result.booking.id, type: "completed" });
    if (result.queueServiceId) {
      try {
        await recalculateQueue(result.queueServiceId);
        await notifyWaitlist(result.queueServiceId);
      } catch (error) {
        console.error("Post-settlement queue refresh failed", error);
      }
    }
  }
  return result.completed;
}

export async function confirmCompletionService(bookingId: string, seekerId: string) {
  return settleCompletedBooking(bookingId, { type: "SEEKER", userId: seekerId });
}

export async function disputeJobService(
  bookingId: string,
  seekerId: string,
  reason: string,
  description?: string,
  evidenceUrl?: string,
) {
  const report = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`completion:${bookingId}`}))`;
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: { queue: true } });
    if (!booking || booking.seekerId !== seekerId) throw httpError("Booking not found or access denied", 404);
    if (booking.status !== "AWAITING_CONFIRMATION") throw httpError("A dispute can only be filed while completion confirmation is pending", 409);
    assertDistinctAccounts(seekerId, booking.providerId, "dispute job");
    const duplicate = await tx.report.findFirst({
      where: { bookingId, reporterId: seekerId, reportType: "COMPLETION_DISPUTE", status: { in: ["PENDING", "UNDER_REVIEW"] } },
    });
    if (duplicate) throw httpError("An unresolved completion dispute already exists", 409, "DUPLICATE_DISPUTE");

    const paymentStatus = booking.paymentMethod === "On-site Cash" ? "UNPAID" : "FROZEN_HELD";
    await tx.booking.update({
      where: { id: booking.id },
      data: { status: "DISPUTED", statusBeforeDispute: booking.status as BookingStatus, paymentStatus },
    });
    if (booking.queue) await tx.queue.update({ where: { id: booking.queue.id }, data: { paymentStatus } });

    const validReasons = ["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE", "SCAM_OR_FRAUD", "INAPPROPRIATE_BEHAVIOR", "OVERPRICING", "NO_SHOW"];
    return tx.report.create({
      data: {
        bookingId: booking.id,
        reporterId: seekerId,
        reportedUserId: booking.providerId,
        reason: validReasons.includes(reason) ? reason as any : "POOR_SERVICE_QUALITY",
        description: description || `Dispute filed: ${reason}`,
        evidenceUrl: evidenceUrl || null,
        reportType: "COMPLETION_DISPUTE",
        status: "PENDING",
      },
    });
  });

  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { providerId: true, seekerId: true } });
  if (booking) {
    await prisma.notification.create({
      data: { userId: booking.providerId, title: "Completion disputed", body: "The seeker opened a completion dispute for administrator review.", link: `/provider/provider-activity?tab=disputed&booking=${bookingId}` },
    });
    safeEmit(`user:${booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId, type: "disputed" });
    safeEmit(`user:${booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId, type: "disputed" });
  }
  return report;
}
