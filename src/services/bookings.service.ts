import { prisma } from "../lib/prisma";
import { recalculateQueue, notifyWaitlist } from "./queue.service";
import { applyCancellationTrust, applyServiceCompletionTrust } from "./trust.service";
import { safeEmit } from "../lib/socket";
import { assertDistinctAccounts } from "../utils/security";
import { sendMessage } from "./messages.service";

// ── FCFS Queue Logic ──────────────────────────────────────────────────────────

export async function getNextQueuePosition(serviceId: string): Promise<number> {
  const lastEntry = await prisma.queue.findFirst({
    where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
    orderBy: { position: "desc" },
  });

  if (lastEntry) {
    return lastEntry.position + 1;
  }

  // If no entry in Queue table, check if the provider is currently serving an ONGOING booking on this service
  const activeOngoing = await prisma.booking.findFirst({
    where: { serviceId, status: "ONGOING" },
  });

  // If there's an ongoing job, position 1 is active, so the next queue entrant is position 2
  return activeOngoing ? 2 : 1;
}

export async function calculateEstimatedWait(
  serviceId: string,
  position: number
): Promise<number> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { estimatedDurationMins: true },
  });
  if (!service) return 0;
  return service.estimatedDurationMins * (position - 1);
}

async function resolveFinalPrice(booking: any): Promise<number> {
  if (booking.directRequest) return Number(booking.directRequest.agreedPrice);
  if (booking.offer) return Number(booking.offer.offeredPrice);
  if (booking.service) return Number(booking.service.price);
  if (booking.serviceId) {
    const service = await prisma.service.findUnique({
      where: { id: booking.serviceId },
      select: { price: true },
    });
    return service ? Number(service.price) : 0;
  }
  return 0;
}

// ── Cash Direct Request (no queue) ────────────────────────────────────────────

export async function createDirectRequest(params: {
  seekerId: string;
  providerId: string;
  serviceId: string;
  agreedPrice: number;
  schedule?: string;
  message?: string;
  scheduledDate?: string; // ISO date e.g. "2026-08-15" — for session-based services
  scheduledTime?: string; // HH:MM e.g. "16:00" — for session-based services
}) {
  const { seekerId, providerId, serviceId, agreedPrice, schedule, message, scheduledDate, scheduledTime } = params;

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
  assertDistinctAccounts(seekerId, providerId, "book service");

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { paymentMethods: true, isAvailable: true, title: true, status: true },
  });

  if (!service || service.status !== "ACTIVE" || !service.isAvailable) {
    const err = new Error("This service listing is currently paused by the provider and is not accepting bookings") as any;
    err.status = 400;
    throw err;
  }

  const pm = service.paymentMethods as any;
  if (!pm?.cash) {
    const err = new Error("This provider does not accept cash payments") as any;
    err.status = 400;
    throw err;
  }

  // Prevent duplicate concurrent bookings on the same service
  const activeExistingBooking = await prisma.booking.findFirst({
    where: {
      seekerId,
      serviceId,
      status: {
        in: ["PENDING_APPROVAL", "WAITING", "ONGOING", "ACCEPTED", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"]
      }
    }
  });

  if (activeExistingBooking) {
    const err = new Error("You already have an active booking for this service in progress. Please check your Activity tab.") as any;
    err.status = 400;
    throw err;
  }

  const { directRequest, booking } = await prisma.$transaction(async (tx) => {
    const directRequest = await tx.directRequest.create({
      data: {
        seekerId,
        providerId,
        serviceId,
        selectedPaymentMethod: "cash",
        agreedPrice,
        schedule,
        message,
        status: "PENDING_APPROVAL",
      },
    });

    const booking = await tx.booking.create({
      data: {
        seekerId,
        providerId,
        serviceId,
        directRequestId: directRequest.id,
        paymentMethod: "On-site Cash",
        paymentStatus: "UNPAID",
        status: "PENDING_APPROVAL",
        started: false,
        scheduledDate: scheduledDate || null,
        scheduledTime: scheduledTime || null,
      },
    });

    return { directRequest, booking };
  });

  // Notify Provider
  await prisma.notification.create({
    data: {
      userId: providerId,
      title: "New Direct Booking Request",
      body: `A new Direct Arrangement booking request has arrived for "${service.title}". Review it in Incoming Requests.`,
      link: `/provider/provider-activity?tab=waiting&booking=${booking.id}`,
    },
  });
  safeEmit(`user:${providerId}`, "notification", { title: "New Direct Booking Request" });
  safeEmit(`user:${providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "created" });
  safeEmit(`user:${seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "created" });

  return { ...directRequest, booking };
}

// ── Respond to Direct Booking (Accept / Decline) ──────────────────────────────

export async function respondToDirectBookingService(requestId: string, providerId: string, accept: boolean) {
  // Check if requestId is a directRequest ID or a booking ID
  let directRequest = await prisma.directRequest.findUnique({
    where: { id: requestId },
    include: { booking: true },
  });

  let targetBooking: any = null;

  if (directRequest) {
    targetBooking = directRequest.booking;
  } else {
    targetBooking = await prisma.booking.findUnique({
      where: { id: requestId },
      include: { directRequest: true, queue: true, service: true },
    });
    if (targetBooking?.directRequest) {
      directRequest = targetBooking.directRequest;
    }
  }

  if (!directRequest && !targetBooking) {
    const err = new Error("Booking request not found") as any;
    err.status = 404;
    throw err;
  }

  const effectiveProviderId = directRequest?.providerId || targetBooking?.providerId;
  const effectiveSeekerId = directRequest?.seekerId || targetBooking?.seekerId;

  if (effectiveProviderId !== providerId) {
    const err = new Error("Access denied") as any;
    err.status = 403;
    throw err;
  }

  // Validate that the request or booking has not already been cancelled or declined
  if (
    (directRequest && directRequest.status === "DECLINED") ||
    (targetBooking && (targetBooking.status === "CANCELED" || targetBooking.status === "DECLINED" || targetBooking.status === "REMOVED"))
  ) {
    const err = new Error("This request has already been cancelled or declined.") as any;
    err.status = 400;
    throw err;
  }

  if (accept) {
    const booking = await prisma.$transaction(async (tx) => {
      if (directRequest) {
        await tx.directRequest.update({
          where: { id: directRequest.id },
          data: { status: "ACCEPTED" },
        });
      }

      if (targetBooking) {
        return tx.booking.update({
          where: { id: targetBooking.id },
          data: { status: "ACCEPTED", started: false },
        });
      }

      return tx.booking.create({
        data: {
          seekerId: directRequest!.seekerId,
          providerId,
          serviceId: directRequest!.serviceId,
          directRequestId: directRequest!.id,
          paymentMethod: "On-site Cash",
          paymentStatus: "UNPAID",
          status: "ACCEPTED",
          started: false,
        },
      });
    });

    // Notify Seeker
    await prisma.notification.create({
      data: {
        userId: effectiveSeekerId,
        title: "Booking Accepted! 🎉",
        body: "Your booking request was accepted! Messaging is now enabled — coordinate details with your provider via chat.",
        link: `/seeker/seeker-activity?tab=all&booking=${booking.id}`,
      },
    });
    safeEmit(`user:${effectiveSeekerId}`, "notification", { title: "Booking Accepted! 🎉" });
    safeEmit(`user:${effectiveSeekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "accepted" });
    safeEmit(`user:${providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "accepted" });
    safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "accepted" });

    // Notify Provider
    await prisma.notification.create({
      data: {
        userId: providerId,
        title: "Booking Confirmed! 🎉",
        body: "You accepted the booking request. Messaging is now open to coordinate with the seeker.",
        link: `/provider/provider-activity?tab=all&booking=${booking.id}`,
      },
    });
    safeEmit(`user:${providerId}`, "notification", { title: "Booking Confirmed! 🎉" });

    // System Message in Conversation
    await sendMessage(booking.id, providerId, "🎉 Agreement reached! Direct chat messaging is now enabled for this transaction.", undefined, true);

    return booking;
  } else {
    // Decline
    const updated = await prisma.$transaction(async (tx) => {
      if (directRequest) {
        await tx.directRequest.update({
          where: { id: directRequest.id },
          data: { status: "DECLINED" },
        });
      }

      if (targetBooking) {
        // If payment was held in escrow (GCash), record refund transaction
        if (targetBooking.paymentStatus === "PAID_HELD") {
          await tx.transaction.create({
            data: {
              walletOwnerId: targetBooking.seekerId,
              amount: targetBooking.service?.price || 0,
              type: "REFUND",
              description: `Escrow refund for declined booking: ${targetBooking.service?.title || 'Service'}`,
              status: "completed",
              relatedBookingId: targetBooking.id,
            },
          });
        }

        return tx.booking.update({
          where: { id: targetBooking.id },
          data: {
            status: "DECLINED",
            paymentStatus: targetBooking.paymentStatus === "PAID_HELD" ? "REFUNDED" : targetBooking.paymentStatus,
          },
        });
      }

      return null;
    });

    await prisma.notification.create({
      data: {
        userId: effectiveSeekerId,
        title: "Booking Request Declined ❌",
        body: targetBooking?.paymentStatus === "PAID_HELD"
          ? "Your booking request was declined by the provider. Your Escrow payment has been refunded."
          : "Your booking request was declined by the provider.",
        link: `/seeker/seeker-activity?tab=canceled&booking=${targetBooking?.id || directRequest?.id}`,
      },
    });
    safeEmit(`user:${effectiveSeekerId}`, "notification", { title: "Booking Request Declined ❌" });
    safeEmit(`user:${effectiveSeekerId}`, "ENGAGEMENT_CHANGED", { bookingId: targetBooking?.id || directRequest?.id, type: "declined" });
    safeEmit(`user:${providerId}`, "ENGAGEMENT_CHANGED", { bookingId: targetBooking?.id || directRequest?.id, type: "declined" });

    return updated;
  }
}

// ── Create Direct Booking from Offer (Flow B Cash path) ─────────────────────────

export async function createDirectFromOfferService(offerId: string, seekerId: string) {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    include: { request: true }
  });

  if (!offer || offer.request.seekerId !== seekerId) {
    const err = new Error("Offer not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
  assertDistinctAccounts(seekerId, offer.providerId, "accept offer");

  const booking = await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: offerId },
      data: { status: "ACCEPTED" },
    });

    await tx.offer.updateMany({
      where: {
        requestId: offer.requestId,
        id: { not: offerId },
      },
      data: { status: "REJECTED" },
    });

    await tx.serviceRequest.update({
      where: { id: offer.requestId },
      data: { status: "IN_PROGRESS" },
    });

    return tx.booking.create({
      data: {
        seekerId,
        providerId: offer.providerId,
        offerId: offer.id,
        paymentMethod: "On-site Cash",
        paymentStatus: "UNPAID",
        status: "ACCEPTED",
      },
    });
  });

  // Notify Provider
  await prisma.notification.create({
    data: {
      userId: offer.providerId,
      title: "Offer Accepted! 💰",
      body: `Your offer on "${offer.request.title}" was accepted! Messaging is now enabled — chat to coordinate service details.`,
      link: `/provider/provider-activity?tab=in_progress&booking=${booking.id}`,
    },
  });
  safeEmit(`user:${offer.providerId}`, "notification", { title: "Offer Accepted! 💰" });
  safeEmit(`user:${offer.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "accepted_offer" });
  safeEmit(`user:${seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "accepted_offer" });
  safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "accepted_offer" });

  // Notify Seeker
  await prisma.notification.create({
    data: {
      userId: seekerId,
      title: "Booking Confirmed! 🎉",
      body: `You accepted the offer for "${offer.request.title}". Messaging is now enabled to coordinate with your provider.`,
      link: `/seeker/seeker-activity?tab=in_progress&booking=${booking.id}`,
    },
  });
  safeEmit(`user:${seekerId}`, "notification", { title: "Booking Confirmed! 🎉" });

  // Automated System Message
  await sendMessage(booking.id, seekerId, "🎉 Agreement reached! Direct chat messaging is now enabled for this transaction.", undefined, true);

  return booking;
}

// ── Online Queue Entry (ONLY after PayMongo payment succeeds) ─────────────────

export async function addToQueue(params: {
  serviceId: string;
  seekerId: string;
  paymentId: string; // PayMongo payment intent ID — REQUIRED
  offerId?: string;  // Only for Flow B (accepted offer)
  scheduledDate?: string; // ISO date e.g. "2026-08-15" — for session-based services
  scheduledTime?: string; // HH:MM e.g. "16:00" — for session-based services
  paymentMethod?: string; // Payment method e.g. "GCash", "Maya", "Card"
}): Promise<{ queueEntry: any; isImmediate: boolean }> {
  const { serviceId, seekerId, paymentId, offerId, scheduledDate, scheduledTime, paymentMethod } = params;

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { queueLimit: true, estimatedDurationMins: true, isAvailable: true, title: true, status: true, providerId: true },
  });

  if (!service || service.status !== "ACTIVE" || (!offerId && !service.isAvailable)) {
    const err = new Error("This service is currently paused by the provider and not available for new bookings") as any;
    err.status = 400;
    throw err;
  }

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
  if (seekerId === service.providerId) {
    const err = new Error("You cannot book or send an offer on your own service listing or request.") as any;
    err.status = 403;
    err.code = "SELF_TRANSACTION_NOT_ALLOWED";
    throw err;
  }

  if (offerId) {
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { request: true },
    });

    if (!offer || offer.status !== "ACCEPTED" || offer.request.seekerId !== seekerId || offer.providerId !== service.providerId) {
      const err = new Error("Accepted offer does not match this online booking") as any;
      err.status = 400;
      throw err;
    }
  }

  // Count total load (active ongoing booking + queued entries)
  const activeOngoingCount = await prisma.booking.count({
    where: { serviceId, status: "ONGOING" },
  });
  const queueCount = await prisma.queue.count({
    where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
  });
  const currentSize = activeOngoingCount + queueCount;

  if (currentSize >= service.queueLimit) {
    const err = new Error("Queue is full. Please join the waitlist instead.") as any;
    err.status = 409;
    err.code = "QUEUE_FULL";
    throw err;
  }

  const position = await getNextQueuePosition(serviceId);
  const estimatedWait = service.estimatedDurationMins * (position - 1);
  const isImmediate = position === 1;

  // Online booking with Escrow (PAID_HELD):
  // Work NEVER starts automatically. If there's an accepted offer (Flow B), status is ACCEPTED.
  // If direct booking on a listing (Flow A), status is PENDING_APPROVAL awaiting provider review.
  // started is ALWAYS false until provider clicks Start Job.
  const booking = await prisma.booking.create({
    data: {
      seekerId,
      providerId: service.providerId,
      serviceId,
      offerId,
      paymentMethod: paymentMethod || "GCash",
      paymentStatus: "PAID_HELD",
      status: offerId ? "ACCEPTED" : "PENDING_APPROVAL",
      queuePosition: position,
      started: false,
      scheduledDate: scheduledDate || null,
      scheduledTime: scheduledTime || null,
    },
  });

  await sendMessage(booking.id, seekerId, "Payment received and held in Escrow.", undefined, true);

  const queueEntry = await prisma.queue.create({
    data: {
      serviceId,
      seekerId,
      offerId: offerId || null,
      paymentId,
      position,
      estimatedWait,
      paymentStatus: "PAID_HELD",
      status: "WAITING",
      bookingId: booking.id,
    },
  });

  // Notify provider of new paid booking request
  await prisma.notification.create({
    data: {
      userId: service.providerId,
      title: "New Paid Booking Request! 🔒",
      body: `A client requested "${service.title}" with payment secured in Escrow via GCash. Review and accept.`,
      link: `/provider/provider-activity?tab=pending&booking=${booking.id}`,
    },
  });

  // ── Real-time: notify all clients watching this service's queue ───────────
  safeEmit(`service:${serviceId}`, "queue_update", {
    serviceId,
    delta: +1,
    currentSize: currentSize + 1,
  });
  // Notify the provider in their personal room
  safeEmit(`user:${service.providerId}`, "notification", { title: "New Paid Booking Request! 🔒" });
  safeEmit(`user:${service.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "queue_created" });
  safeEmit(`user:${seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "queue_created" });

  return { queueEntry, isImmediate };
}


// ── Provider Start Job ────────────────────────────────────────────────────────

export async function providerStartJob(id: string, providerId: string) {
  // Find booking
  let booking = await prisma.booking.findUnique({
    where: { id },
    include: { queue: true }
  });

  let queueEntry = booking?.queue;

  if (!booking) {
    // If not found by booking ID, try by queue ID
    const qe = await prisma.queue.findUnique({
      where: { id },
      include: { booking: true }
    }) as any;
    if (qe) {
      booking = qe.booking;
      queueEntry = qe;
    }
  }

  if (!booking || booking.providerId !== providerId) {
    const err = new Error("Booking or queue entry not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (booking.status === "CANCELED" || booking.status === "DECLINED" || booking.status === "COMPLETED" || booking.status === "REMOVED") {
    const err = new Error(`Cannot start job for a booking with status ${booking.status}.`) as any;
    err.status = 400;
    throw err;
  }

  // Update Booking status to ONGOING and started to true
  const updatedBooking = await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: "ONGOING",
      started: true
    }
  });

  // Starting a queued job removes it from Queue; active work is tracked by Booking.
  if (queueEntry) {
    await prisma.queue.delete({
      where: { id: queueEntry.id },
    });
    await recalculateQueue(queueEntry.serviceId);
    await notifyWaitlist(queueEntry.serviceId);
  }

  // Notify seeker
  await prisma.notification.create({
    data: {
      userId: booking.seekerId,
      title: "Provider Started Job! 🚀",
      body: "Your provider has started serving your request. Coordinates are active.",
      link: `/seeker/seeker-activity?tab=active&booking=${booking.id}`,
    },
  });
  safeEmit(`user:${booking.seekerId}`, "notification", { title: "Provider Started Job! 🚀" });
  safeEmit(`user:${booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "started" });
  safeEmit(`user:${booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "started" });
  safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "started" });
  await sendMessage(booking.id, booking.providerId, "Provider started the job.", undefined, true);

  return updatedBooking;
}

// ── Provider Remove Queue Entry ───────────────────────────────────────────────

export async function providerRemoveQueueEntry(queueId: string, providerId: string) {
  const queueEntry = await prisma.queue.findUnique({
    where: { id: queueId },
    include: { service: true }
  });

  if (!queueEntry || queueEntry.service.providerId !== providerId) {
    const err = new Error("Queue entry not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  // Update Queue status to REMOVED
  await prisma.queue.update({
    where: { id: queueId },
    data: { status: "REMOVED", paymentStatus: "FROZEN_HELD" }
  });

  // Update corresponding Booking status to REMOVED
  if (queueEntry.bookingId) {
    await prisma.booking.update({
      where: { id: queueEntry.bookingId },
      data: { status: "REMOVED", paymentStatus: "FROZEN_HELD" }
    });
    await sendMessage(queueEntry.bookingId, providerId, "Booking cancelled.", undefined, true);
  }

  // Deduct provider trust score (-5 for cancellation/removal at fault)
  await applyCancellationTrust(providerId, true);

  // Recalculate queue and notify waitlist
  await recalculateQueue(queueEntry.serviceId);
  await notifyWaitlist(queueEntry.serviceId);

  // Notify seeker
  await prisma.notification.create({
    data: {
      userId: queueEntry.seekerId,
      title: "Booking Cancelled by Provider ⚠️",
      body: "The provider removed your booking from their queue. Refund is being processed.",
      link: `/seeker/seeker-activity?tab=canceled&booking=${queueEntry.bookingId}`,
    },
  });

  // ── Real-time queue update ────────────────────────────────────────────────
  safeEmit(`service:${queueEntry.serviceId}`, "queue_update", { serviceId: queueEntry.serviceId, delta: -1 });
  safeEmit(`user:${queueEntry.seekerId}`, "notification", { title: "Booking Cancelled by Provider ⚠️" });
  safeEmit(`user:${queueEntry.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: queueEntry.bookingId, type: "removed" });
  safeEmit(`user:${providerId}`, "ENGAGEMENT_CHANGED", { bookingId: queueEntry.bookingId, type: "removed" });

  return { success: true };
}

// ── Provider: Mark Job Complete ────────────────────────────────────────────────

export async function markJobComplete(id: string, providerId: string) {
  // Find booking or queue entry
  let booking: any = await prisma.booking.findUnique({
    where: { id },
    include: { queue: true }
  });

  let queueEntry: any = null;
  if (!booking) {
    // Maybe the passed ID is a queue ID
    queueEntry = await prisma.queue.findUnique({
      where: { id },
      include: { booking: true }
    });
    if (queueEntry) {
      booking = queueEntry.booking;
    }
  } else {
    queueEntry = booking.queue;
  }

  if (!booking) {
    const err = new Error("Booking or queue entry not found") as any;
    err.status = 404;
    throw err;
  }

  // Verify provider
  if (booking.providerId !== providerId) {
    const err = new Error("Access denied") as any;
    err.status = 403;
    throw err;
  }

  if (booking.status !== "ONGOING") {
    const err = new Error("Only ongoing jobs can be marked completed") as any;
    err.status = 400;
    throw err;
  }

  // Transition booking status to AWAITING_CONFIRMATION
  await prisma.booking.update({
    where: { id: booking.id },
    data: { status: "AWAITING_CONFIRMATION" }
  });

  // Notify seeker to confirm
  await prisma.notification.create({
    data: {
      userId: booking.seekerId,
      title: "Service Completed — Please Confirm ✅",
      body: "Your provider has marked the job as done. Go to Activity → Awaiting Confirmation to confirm and release payment.",
      link: `/seeker/seeker-activity?tab=action_required&booking=${booking.id}`,
    },
  });

  // ── Real-time: notify seeker to confirm ──────────────────────────────────
  safeEmit(`user:${booking.seekerId}`, "notification", { title: "Service Completed — Please Confirm ✅" });
  safeEmit(`user:${booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "awaiting_confirmation" });
  safeEmit(`user:${booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "awaiting_confirmation" });
  safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "awaiting_confirmation" });
  if (queueEntry) safeEmit(`service:${queueEntry.serviceId}`, "queue_update", { serviceId: queueEntry.serviceId, delta: 0 });

  return booking;
}

// ── Seeker: Confirm Completion (release escrow) ───────────────────────────────

export async function confirmCompletionService(bookingId: string, seekerId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { queue: true, directRequest: true, offer: true, service: true }
  });

  if (!booking || booking.seekerId !== seekerId) {
    const err = new Error("Booking not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (booking.status !== "AWAITING_CONFIRMATION") {
    const err = new Error("Completion can only be confirmed after the provider marks the job completed") as any;
    err.status = 400;
    throw err;
  }

  const finalPrice = await resolveFinalPrice(booking);

  // Create CompletedService record
  const completedService = await prisma.completedService.create({
    data: {
      bookingId: booking.id,
      queueId: booking.queue?.id || null,
      directRequestId: booking.directRequestId,
      offerId: booking.offerId,
      seekerId: booking.seekerId,
      providerId: booking.providerId,
      finalPrice,
      paymentStatus: "RELEASED"
    }
  });

  // Update Booking status
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: "COMPLETED",
      paymentStatus: "RELEASED"
    }
  });

  // Mark the ServiceRequest as permanently closed — it was fulfilled
  if (booking.offerId) {
    const offerObj = await prisma.offer.findUnique({
      where: { id: booking.offerId },
      select: { requestId: true }
    });
    if (offerObj?.requestId) {
      await prisma.serviceRequest.update({
        where: { id: offerObj.requestId },
        data: { status: "CLOSED" }
      });
    }
  }

  if (booking.paymentMethod === 'GCash') {
    await sendMessage(booking.id, seekerId, "Funds released.", undefined, true);
  } else {
    await sendMessage(booking.id, seekerId, "Transaction completed.", undefined, true);
  }

  // Release escrow / log earning transaction for provider
  await prisma.transaction.create({
    data: {
      walletOwnerId: booking.providerId,
      type: "EARNING",
      amount: finalPrice,
      relatedBookingId: completedService.id,
      description: booking.paymentMethod === "GCash"
        ? "Payment released by seeker confirmation"
        : "Cash payment confirmed by seeker",
    },
  });

  // Trust score: successful completion — routed through centralized trust service
  // which also writes the immutable TrustScoreEvent history record.
  if (booking.providerId !== booking.seekerId) {
    await applyServiceCompletionTrust(booking.providerId);
  }

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: booking.providerId,
      title: "Payment Confirmed 💰",
      body: booking.paymentMethod === "GCash"
        ? `₱${finalPrice} has been released to your wallet.`
        : `Seeker confirmed completion of cash-based job for ₱${finalPrice}.`,
      link: `/provider/provider-activity?tab=all&booking=${booking.id}`,
    },
  });
  safeEmit(`user:${booking.providerId}`, "notification", { title: "Payment Confirmed 💰" });
  safeEmit(`user:${booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "completed" });
  safeEmit(`user:${booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "completed" });
  safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "completed" });

  return completedService;
}

// ── Seeker: Dispute Job ───────────────────────────────────────────────────────

export async function disputeJobService(
  bookingId: string,
  seekerId: string,
  reason: string,
  description?: string,
  evidenceUrl?: string
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking || booking.seekerId !== seekerId) {
    const err = new Error("Booking not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (booking.status !== "AWAITING_CONFIRMATION") {
    const err = new Error("A dispute can only be filed while the booking is awaiting seeker confirmation") as any;
    err.status = 400;
    throw err;
  }

  assertDistinctAccounts(seekerId, booking.providerId, "dispute job");

  // Update Booking status to DISPUTED and paymentStatus to FROZEN_HELD
  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: "DISPUTED",
      paymentStatus: "FROZEN_HELD"
    }
  });

  // Map reason string to ReportReason enum if possible, else default
  let reportReason: any = "POOR_SERVICE_QUALITY";
  const validReasons = ["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE", "SCAM_OR_FRAUD", "INAPPROPRIATE_BEHAVIOR", "OVERPRICING", "NO_SHOW"];
  if (validReasons.includes(reason)) {
    reportReason = reason;
  }

  // Create a Report record
  const report = await prisma.report.create({
    data: {
      bookingId: booking.id,
      reporterId: seekerId,
      reportedUserId: booking.providerId,
      reason: reportReason,
      description: description || `Dispute filed: ${reason}`,
      evidenceUrl: evidenceUrl || null,
      status: "PENDING"
    }
  });

  // If there's an associated queue entry, freeze its paymentStatus
  if (booking.queuePosition) {
    await prisma.queue.updateMany({
      where: { bookingId: booking.id },
      data: { paymentStatus: "FROZEN_HELD" }
    });
  }

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: booking.providerId,
      title: "Job Disputed ⚠️",
      body: `Seeker has raised a dispute for your booking. Administration will review.`,
      link: `/provider/provider-activity?tab=disputed&booking=${booking.id}`,
    },
  });
  safeEmit(`user:${booking.providerId}`, "notification", { title: "Job Disputed ⚠️" });
  safeEmit(`user:${booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "disputed" });
  safeEmit(`user:${booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "disputed" });
  safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "disputed" });

  return report;
}

// ── Seeker: Join Waitlist (Notify Me When Open) ───────────────────────────────

export async function joinWaitlist(serviceId: string, seekerId: string) {
  // Prevent duplicate waitlist if seeker already has an active booking
  const activeExistingBooking = await prisma.booking.findFirst({
    where: {
      seekerId,
      serviceId,
      status: {
        in: ["PENDING_APPROVAL", "WAITING", "ONGOING", "ACCEPTED", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"]
      }
    }
  });

  if (activeExistingBooking) {
    const err = new Error("You already have an active booking for this service in progress. Please check your Activity tab.") as any;
    err.status = 400;
    throw err;
  }

  // Check if already on waitlist
  const existing = await prisma.queueNotify.findUnique({
    where: { serviceId_seekerId: { serviceId, seekerId } },
  });

  if (existing) {
    const err = new Error("You are already on the waitlist for this service") as any;
    err.status = 409;
    throw err;
  }

  return prisma.queueNotify.create({ data: { serviceId, seekerId } });
}

// ── Seeker: Cancel Queue Entry ────────────────────────────────────────────────

export async function cancelQueueEntry(queueId: string, seekerId: string) {
  const entry = await prisma.queue.findUnique({
    where: { id: queueId },
    select: { id: true, seekerId: true, serviceId: true, status: true, paymentId: true, paymentStatus: true, bookingId: true }
  });

  if (!entry || entry.seekerId !== seekerId) {
    const err = new Error("Queue entry not found") as any;
    err.status = 404;
    throw err;
  }

  if (entry.status === "DONE") {
    const err = new Error("Cannot cancel a completed job") as any;
    err.status = 400;
    throw err;
  }

  // Per spec Part 9: started boolean on Booking is the single source of truth
  if (entry.bookingId) {
    const booking = await prisma.booking.findUnique({
      where: { id: entry.bookingId },
      select: { started: true }
    });
    if (booking?.started) {
      await applyCancellationTrust(seekerId, false);
    }
  }

  await prisma.queue.update({
    where: { id: queueId },
    data: { status: "CANCELLED", paymentStatus: entry.paymentStatus === "PAID_HELD" ? "REFUNDED" : entry.paymentStatus }
  });

  if (entry.bookingId) {
    await prisma.booking.update({
      where: { id: entry.bookingId },
      data: { status: "CANCELED", paymentStatus: entry.paymentStatus === "PAID_HELD" ? "REFUNDED" : "UNPAID" }
    });
    await sendMessage(entry.bookingId, seekerId, "Booking cancelled.", undefined, true);
  }

  // If an online payment was refunded, create a REFUND transaction record (Spec Part 5)
  if (entry.paymentStatus === "PAID_HELD") {
    const booking = await prisma.booking.findUnique({
      where: { id: entry.bookingId || undefined },
      include: { service: true, offer: true, directRequest: true }
    });
    let refundAmount = 0;
    if (booking) {
      if (booking.directRequest) {
        refundAmount = Number(booking.directRequest.agreedPrice);
      } else if (booking.offer) {
        refundAmount = Number(booking.offer.offeredPrice);
      } else if (booking.service) {
        refundAmount = Number(booking.service.price);
      }
    }
    if (refundAmount > 0) {
      await prisma.transaction.create({
        data: {
          walletOwnerId: seekerId,
          type: "REFUND",
          amount: refundAmount,
          relatedBookingId: entry.bookingId,
          description: "Full refund for cancelled queue booking",
        },
      });
    }
  }

  await recalculateQueue(entry.serviceId);
  await notifyWaitlist(entry.serviceId);

  // ── Real-time queue update ────────────────────────────────────────────────
  safeEmit(`service:${entry.serviceId}`, "queue_update", { serviceId: entry.serviceId, delta: -1 });

  return { cancelled: true };
}

// ── Hide / Dismiss Booking from User View ─────────────────────────────────────

export async function hideBookingService(bookingId: string, userId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    const err = new Error("Booking not found") as any;
    err.status = 404;
    throw err;
  }

  if (booking.seekerId !== userId && booking.providerId !== userId) {
    const err = new Error("Access denied") as any;
    err.status = 403;
    throw err;
  }

  const isSeeker = booking.seekerId === userId;
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: isSeeker ? { hiddenBySeeker: true } : { hiddenByProvider: true }
  });

  // Emit engagement change to that user's socket so their UI updates immediately
  safeEmit(`user:${userId}`, "ENGAGEMENT_CHANGED", { bookingId, type: "hidden" });

  return { success: true, bookingId: updated.id };
}
