import { prisma } from "../../lib/prisma";
import { safeEmit } from "../../lib/socket";
import { sendMessage } from "../messages.service";
import { lockServiceQueue, recalculateQueueInTransaction } from "../queue.service";

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

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-start:${providerId}`}))`;
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
    if (booking.status !== "ACCEPTED") {
      const error = new Error("Only an accepted booking can be started.") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const otherOngoing = await tx.booking.count({
      where: { providerId, status: "ONGOING", id: { not: booking.id } },
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

    if (queueEntry) {
      await lockServiceQueue(tx, queueEntry.serviceId);
      const firstWaiting = await tx.queue.findFirst({
        where: { serviceId: queueEntry.serviceId, status: "WAITING" },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      const ongoing = await tx.booking.count({
        where: { serviceId: queueEntry.serviceId, status: "ONGOING" },
      });
      if (firstWaiting?.id !== queueEntry.id || ongoing > 0) {
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
      where: { id: booking.id },
      data: {
        status: "ONGOING",
        started: true,
        ...(queueEntry ? { queuePosition: 1 } : {}),
      },
    });
    if (queueEntry) {
      await recalculateQueueInTransaction(tx, queueEntry.serviceId);
    }
    return { booking: updatedBooking, queueEntry };
  });

  const { booking } = result;

  await prisma.notification.create({
    data: {
      userId: booking.seekerId,
      title: "Provider Started Job",
      body: "Your provider has started serving your request. Coordination is active.",
      link: `/seeker/seeker-activity?tab=active&booking=${booking.id}`,
    },
  });
  safeEmit(`user:${booking.seekerId}`, "notification", { title: "Provider Started Job" });
  safeEmit(`user:${booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "started" });
  safeEmit(`user:${booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "started" });
  safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "started" });
  await sendMessage(booking.id, booking.providerId, "Provider started the job.", undefined, true);

  return booking;
}
