import type { BookingStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { applyTrustEventInTransaction } from "../trust.service";
import { assertDistinctAccounts } from "../../utils/security";
import {
  emitWaitlistNotification,
  lockProviderQueue,
  notifyWaitlistInTransaction,
  recalculateQueueInTransaction,
  type WaitlistNotification,
} from "../queue.service";
import { assertNoRefundInProgress, lockBookingLifecycle } from "../booking-lifecycle.service";
import { assertNoFinancialResolutionReserved } from "../case-resolution.service";
import { recordBookingProgress } from "../booking-progress.service";
import { recordLifecycleNotice, publishLifecycleChange } from './lifecycle-events';

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
    await lockBookingLifecycle(tx, booking.id);
    const fresh = await tx.booking.findUnique({ where: { id: booking.id }, include: { queue: true } });
    if (!fresh || fresh.providerId !== providerId) throw httpError("Access denied", 403);
    await assertNoRefundInProgress(tx, booking.id);
    if (fresh.status === "AWAITING_CONFIRMATION") {
      return { booking: fresh, queue: fresh.queue, changed: false, waitlistNotification: null };
    }
    if (fresh.status !== "ONGOING") throw httpError("Only an ongoing job can be marked complete", 409);

    const updated = await tx.booking.update({
      where: { id: fresh.id },
      data: { status: "AWAITING_CONFIRMATION" },
    });
    const progressEvent = await recordBookingProgress(tx, fresh.id, "WORK_MARKED_COMPLETE", "PROVIDER", `work-complete:${updated.updatedAt.toISOString()}`);
    let waitlistNotification: WaitlistNotification | null = null;
    if (fresh.queue) {
      await lockProviderQueue(tx, fresh.providerId);
      await tx.queue.update({ where: { id: fresh.queue.id }, data: { status: "DONE" } });
      await recalculateQueueInTransaction(tx, fresh.providerId);
      waitlistNotification = await notifyWaitlistInTransaction(tx, fresh.providerId);
    } else {
      await recalculateQueueInTransaction(tx, fresh.providerId);
    }
    const recorded = await recordLifecycleNotice(tx, updated, {
      userId: updated.seekerId,
      title: "Service marked complete",
      body: "Review the completed work, then confirm completion or open a dispute.",
      link: `/seeker/seeker-activity?tab=action_required&booking=${updated.id}`,
    });
    return { booking: updated, queue: fresh.queue, changed: true, waitlistNotification, progressEvent, recorded };
  });

  emitWaitlistNotification(result.waitlistNotification ?? null);
  if (result.changed && result.recorded) {
    publishLifecycleChange(result.booking, 'awaiting_confirmation', result.recorded, true);
  }
  return { ...result.booking, progressEvent: result.progressEvent };
}

export async function settleCompletedBooking(
  bookingId: string,
  actor: { type: "SEEKER"; userId: string } | { type: "ADMIN"; userId: string },
) {
  const result = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, bookingId);
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { queue: true, offer: { select: { requestId: true } }, completedService: true },
    });
    if (!booking) throw httpError("Booking not found", 404);
    await assertNoRefundInProgress(tx, bookingId);
    if (actor.type === "SEEKER" && booking.seekerId !== actor.userId) throw httpError("Access denied", 403);
    if (booking.status === "COMPLETED" && booking.completedService) return { completed: booking.completedService, booking, changed: false };
    const allowed = actor.type === "ADMIN"
      ? ["AWAITING_CONFIRMATION", "DISPUTED", "UNDER_REVIEW"].includes(booking.status)
      : booking.status === "AWAITING_CONFIRMATION";
    if (!allowed) throw httpError("This booking is not ready for completion settlement", 409);
    if (actor.type === "ADMIN" && ["DISPUTED", "UNDER_REVIEW"].includes(booking.status) && booking.statusBeforeDispute !== "AWAITING_CONFIRMATION") {
      throw httpError("Only a disputed completion awaiting seeker confirmation can be administratively completed", 422, "INVALID_DISPUTE_COMPLETION_STATE");
    }
    const isCash = booking.paymentMethod === "On-site Cash";
    const validPaymentState = isCash
      ? booking.paymentStatus === "UNPAID"
      : actor.type === "ADMIN" && booking.status === "DISPUTED"
        ? booking.paymentStatus === "FROZEN_HELD"
        : booking.paymentStatus === "PAID_HELD";
    if (!validPaymentState) throw httpError("This booking's payment state cannot be completed", 409, "INVALID_COMPLETION_PAYMENT_STATE");
    if (!booking.agreedAmount || Number(booking.agreedAmount) <= 0) throw httpError("Booking has no valid agreed amount", 409, "AGREED_AMOUNT_MISSING");

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
    const progressEvent = await recordBookingProgress(tx, booking.id, "COMPLETION_CONFIRMED", actor.type);
    if (booking.queue) {
      await lockProviderQueue(tx, booking.providerId);
      await tx.queue.update({ where: { id: booking.queue.id }, data: { status: "DONE", paymentStatus: settlementStatus } });
      await recalculateQueueInTransaction(tx, booking.providerId);
    }
    if (booking.offer?.requestId) {
      await tx.serviceRequest.update({ where: { id: booking.offer.requestId }, data: { status: "CLOSED" } });
    }
    if (actor.type === "SEEKER") {
      await tx.completionEscalation.updateMany({
        where: { bookingId: booking.id, status: { in: ["PENDING", "UNDER_REVIEW"] } },
        data: { status: "RESOLVED", resolution: "SEEKER_CONFIRMED", resolvedAt: new Date() },
      });
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

    if (booking.providerId !== booking.seekerId) {
      await applyTrustEventInTransaction(tx, {
        userId: booking.providerId,
        delta: 3,
        reason: "Service completed successfully",
        eventKey: `booking-completion:${booking.id}:provider`,
      });
    }
    const recorded = await recordLifecycleNotice(tx, updatedBooking, {
      userId: booking.providerId,
      title: "Completion confirmed",
      body: actor.type === "ADMIN"
        ? "An administrator reviewed the booking and confirmed completion."
        : isCash
          ? "The seeker confirmed completion of the on-site cash booking."
          : "The seeker confirmed completion and the internal payment hold was released.",
      link: `/provider/provider-activity?tab=all&booking=${booking.id}`,
    }, {
      senderId: actor.userId,
      content: isCash ? "Cash service completion confirmed." : "Online payment released after completion confirmation.",
    });
    return { completed, booking: updatedBooking, changed: true, isCash, progressEvent, recorded };
  });

  if (result.changed && result.recorded) {
    publishLifecycleChange(result.booking, 'completed', result.recorded);
  }
  return { ...result.completed, booking: result.booking, progressEvent: result.progressEvent };
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
  const result = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, bookingId);
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: { queue: true } });
    if (!booking || booking.seekerId !== seekerId) throw httpError("Booking not found or access denied", 404);
    await assertNoRefundInProgress(tx, bookingId);
    await assertNoFinancialResolutionReserved(tx, bookingId);
    const duplicate = await tx.report.findFirst({
      where: { bookingId, reporterId: seekerId, reportType: "COMPLETION_DISPUTE", status: { in: ["PENDING", "UNDER_REVIEW"] } },
    });
    if (duplicate) throw httpError("An unresolved completion dispute already exists", 409, "DUPLICATE_DISPUTE");
    if (booking.status !== "AWAITING_CONFIRMATION") throw httpError("A dispute can only be filed while completion confirmation is pending", 409);
    assertDistinctAccounts(seekerId, booking.providerId, "dispute job");

    const paymentStatus = booking.paymentMethod === "On-site Cash" ? "UNPAID" : "FROZEN_HELD";
    const updatedBooking = await tx.booking.update({
      where: { id: booking.id },
      data: { status: "DISPUTED", statusBeforeDispute: booking.status as BookingStatus, paymentStatus },
    });
    if (booking.queue) await tx.queue.update({ where: { id: booking.queue.id }, data: { paymentStatus } });
    await tx.completionEscalation.updateMany({
      where: { bookingId: booking.id, status: { in: ["PENDING", "UNDER_REVIEW"] } },
      data: { status: "DISMISSED", resolution: "SUPERSEDED_BY_SEEKER_DISPUTE", resolvedAt: new Date() },
    });

    const validReasons = ["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE", "SCAM_OR_FRAUD", "INAPPROPRIATE_BEHAVIOR", "OVERPRICING", "NO_SHOW"];
    const report = await tx.report.create({
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
    const recorded = await recordLifecycleNotice(tx, booking, {
      userId: booking.providerId, title: "Completion disputed",
      body: "The seeker opened a completion dispute for administrator review.",
      link: `/provider/provider-activity?tab=disputed&booking=${bookingId}`,
    });
    return { report, booking: updatedBooking, recorded };
  });
  publishLifecycleChange(result.booking, 'disputed', result.recorded);
  return { ...result.report, booking: result.booking };
}
