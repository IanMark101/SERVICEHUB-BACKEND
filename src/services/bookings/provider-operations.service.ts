import { prisma } from "../../lib/prisma";
import { lockProviderQueue, recalculateQueueInTransaction } from "../queue.service";
import { assertNoRefundInProgress, lockBookingLifecycle } from "../booking-lifecycle.service";
import { paidStartBlockReason } from "./paid-start-readiness";
import { recordBookingProgress } from "../booking-progress.service";
import { recordLifecycleNotice, publishLifecycleChange } from './lifecycle-events';

export async function providerStartJob(id: string, providerId: string) {
  const result = await prisma.$transaction(async (tx) => {
    let booking = await tx.booking.findUnique({ where: { id }, include: { queue: true } });
    let queueEntry = booking?.queue ?? null;

    if (!booking) {
      const entry = await tx.queue.findUnique({
        where: { id },
        include: { booking: { include: { queue: true } } },
      });
      booking = entry?.booking ?? null;
      queueEntry = entry ?? null;
    }

    if (!booking || booking.providerId !== providerId) {
      const error = new Error("Booking or queue entry not found or access denied") as Error & { status?: number };
      error.status = 404;
      throw error;
    }

    await lockBookingLifecycle(tx, booking.id);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-start:${providerId}`}))`;
    const fresh = await tx.booking.findUnique({
      where: { id: booking.id },
      include: { queue: true },
    });
    if (!fresh || fresh.providerId !== providerId) {
      const error = new Error("Booking or queue entry not found or access denied") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    booking = fresh;
    queueEntry = fresh.queue;
    await assertNoRefundInProgress(tx, booking.id);
    const provider = await tx.user.findUnique({
      where: { id: providerId },
      select: { isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true },
    });
    if (
      !provider ||
      !provider.isActive ||
      provider.moderationStatus !== "ACTIVE" ||
      !provider.emailVerified ||
      provider.verificationStatus !== "APPROVED"
    ) {
      const error = new Error("Your account is not eligible to start a new job") as Error & {
        status?: number;
        code?: string;
      };
      error.status = 403;
      error.code = "START_JOB_NOT_ALLOWED";
      throw error;
    }
    if (!queueEntry && booking.paymentMethod !== "On-site Cash") {
      throw Object.assign(new Error("This paid booking has no active queue entry. Refresh your workload and contact support if it remains listed."), { status: 409, code: "START_PAID_QUEUE_MISSING" });
    }
    if (!queueEntry && (booking.status !== "ACCEPTED" || booking.started)) {
      const error = new Error("Only an accepted booking can be started.") as Error & { status?: number };
      error.status = 400;
      throw error;
    }
    if (!queueEntry && (booking.paymentMethod !== "On-site Cash" || booking.paymentStatus !== "UNPAID")) {
      throw Object.assign(new Error("This booking has no valid cash arrangement or confirmed paid queue entry."), { status: 409, code: "START_PAYMENT_STATE_INVALID" });
    }
    if (queueEntry) {
      if (booking.paymentMethod === "On-site Cash") {
        throw Object.assign(new Error("Cash bookings cannot enter the paid queue."), { status: 409, code: "START_PAYMENT_STATE_INVALID" });
      }
      const blocked = paidStartBlockReason({
        bookingStatus: booking.status,
        bookingStarted: booking.started,
        bookingPaymentStatus: booking.paymentStatus,
        queueStatus: queueEntry.status,
        queuePaymentStatus: queueEntry.paymentStatus,
      });
      if (blocked) throw Object.assign(new Error(blocked), { status: 409, code: "PAID_JOB_NOT_READY" });
    }

    const otherOngoing = await tx.booking.count({
      where: {
        providerId,
        id: { not: booking.id },
        OR: [
          { status: "ONGOING" },
          { started: true, paymentMethod: "On-site Cash", status: { in: ["DISPUTED", "UNDER_REVIEW"] } },
          { queue: { is: { status: "SERVING" } } },
        ],
      },
    });
    if (otherOngoing > 0) {
      const error = new Error("Finish your current ongoing job before starting another one") as Error & {
        status?: number;
        code?: string;
      };
      error.status = 409;
      error.code = "PROVIDER_ALREADY_ONGOING";
      throw error;
    }

    if (!queueEntry) {
      await lockProviderQueue(tx, providerId);
      const paidWaiting = await tx.queue.count({ where: { providerId, status: "WAITING" } });
      if (paidWaiting > 0) {
        const error = new Error("Start the next paid booking before starting a cash arrangement.") as Error & { status?: number; code?: string };
        error.status = 409;
        error.code = "PAID_WORK_WAITING";
        throw error;
      }
    }
    if (queueEntry) {
      await lockProviderQueue(tx, providerId);
      const firstWaiting = await tx.queue.findFirst({
        where: { providerId, status: "WAITING" },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      const serving = await tx.queue.count({
        where: { providerId, status: "SERVING" },
      });
      if (firstWaiting?.id !== queueEntry.id || serving > 0) {
        const error = new Error("Start the first waiting booking after the current job is completed.") as Error & {
          status?: number;
        };
        error.status = 409;
        throw error;
      }
      await tx.queue.update({
        where: { id: queueEntry.id },
        data: { status: "SERVING", position: 1, estimatedWait: 0 },
      });
    }

    const updatedBooking = await tx.booking.update({
      where: { id: booking.id, status: { in: queueEntry ? ["ACCEPTED", "WAITING"] : ["ACCEPTED"] }, started: false },
      data: {
        status: "ONGOING",
        started: true,
        ...(queueEntry ? { queuePosition: 1 } : {}),
      },
    });
    const progressEvent = await recordBookingProgress(tx, booking.id, "STARTED", "PROVIDER");
    // A cash start already holds the queue lock and proved there are no paid
    // waiting/serving jobs. There is nothing to reorder in that branch.
    if (queueEntry) await recalculateQueueInTransaction(tx, providerId);
    const recorded = await recordLifecycleNotice(tx, updatedBooking, {
      userId: booking.seekerId,
      title: "Provider Started Job",
      body: "Your provider has started serving your request. Coordination is active.",
      link: `/seeker/seeker-activity?tab=active&booking=${booking.id}`,
    }, { senderId: booking.providerId, content: "Provider started the job." });
    return { booking: updatedBooking, queueEntry, progressEvent, recorded };
  });

  const { booking } = result;
  publishLifecycleChange(booking, 'started', result.recorded, !!result.queueEntry);
  return { ...booking, progressEvent: result.progressEvent };
}
