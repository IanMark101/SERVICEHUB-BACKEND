import { prisma } from "../lib/prisma";
import { recalculateQueue, notifyWaitlist } from "./queue.service";
import { applyCancellationTrust } from "./trust.service";
import { safeEmit } from "../lib/socket";

// ── FCFS Queue Logic ──────────────────────────────────────────────────────────

export async function getNextQueuePosition(serviceId: string): Promise<number> {
  const lastEntry = await prisma.queue.findFirst({
    where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
    orderBy: { position: "desc" },
  });
  return (lastEntry?.position ?? 0) + 1;
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
}) {
  const { seekerId, providerId, serviceId, agreedPrice, schedule, message } = params;

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
  // A user must never be able to book their own service listing.
  if (seekerId === providerId) {
    const err = new Error("You cannot book or send an offer on your own service listing or request.") as any;
    err.status = 403;
    err.code = "SELF_TRANSACTION_NOT_ALLOWED";
    throw err;
  }

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { paymentMethods: true, isAvailable: true, title: true, status: true },
  });

  if (!service || service.status !== "ACTIVE") {
    const err = new Error("Service not found or not available") as any;
    err.status = 404;
    throw err;
  }

  const pm = service.paymentMethods as any;
  if (!pm?.cash) {
    const err = new Error("This provider does not accept cash payments") as any;
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
      },
    });

    return { directRequest, booking };
  });

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: providerId,
      title: "New Direct Booking Request",
      body: `A new Direct Arrangement booking request has arrived for "${service.title}". Review it in Incoming Requests.`,
    },
  });

  return { ...directRequest, booking };
}

// ── Respond to Direct Booking (Accept / Decline) ──────────────────────────────

export async function respondToDirectBookingService(requestId: string, providerId: string, accept: boolean) {
  const directRequest = await prisma.directRequest.findUnique({
    where: { id: requestId },
    include: { booking: true },
  });

  if (!directRequest || directRequest.providerId !== providerId) {
    const err = new Error("Direct request not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  const existingBooking = directRequest.booking;

  if (accept) {
    const booking = await prisma.$transaction(async (tx) => {
      await tx.directRequest.update({
        where: { id: requestId },
        data: { status: "ACCEPTED" },
      });

      if (existingBooking) {
        return tx.booking.update({
          where: { id: existingBooking.id },
          data: { status: "ACCEPTED" },
        });
      }

      return tx.booking.create({
        data: {
          seekerId: directRequest.seekerId,
          providerId,
          serviceId: directRequest.serviceId,
          directRequestId: directRequest.id,
          paymentMethod: "On-site Cash",
          paymentStatus: "UNPAID",
          status: "ACCEPTED",
        },
      });
    });

    await prisma.notification.create({
      data: {
        userId: directRequest.seekerId,
        title: "Direct Booking Accepted! 🎉",
        body: "Your direct booking request has been accepted. Coordinate with the provider via chat.",
      },
    });

    return booking;
  } else {
    const updatedRequest = await prisma.$transaction(async (tx) => {
      if (existingBooking) {
        await tx.booking.update({
          where: { id: existingBooking.id },
          data: { status: "DECLINED" },
        });
      }

      return tx.directRequest.update({
        where: { id: requestId },
        data: { status: "DECLINED" },
      });
    });

    await prisma.notification.create({
      data: {
        userId: directRequest.seekerId,
        title: "Direct Booking Declined ❌",
        body: "Your direct booking request was declined by the provider.",
      },
    });

    return updatedRequest;
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
  if (seekerId === offer.providerId) {
    const err = new Error("You cannot book or send an offer on your own service listing or request.") as any;
    err.status = 403;
    err.code = "SELF_TRANSACTION_NOT_ALLOWED";
    throw err;
  }

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

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: offer.providerId,
      title: "Offer Accepted! 💰",
      body: `Your offer on "${offer.request.title}" has been accepted. Cash on-site arranged.`,
    },
  });

  return booking;
}

// ── Online Queue Entry (ONLY after PayMongo payment succeeds) ─────────────────

export async function addToQueue(params: {
  serviceId: string;
  seekerId: string;
  paymentId: string; // PayMongo payment intent ID — REQUIRED
  offerId?: string;  // Only for Flow B (accepted offer)
}): Promise<{ queueEntry: any; isImmediate: boolean }> {
  const { serviceId, seekerId, paymentId, offerId } = params;

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { queueLimit: true, estimatedDurationMins: true, isAvailable: true, title: true, status: true, providerId: true },
  });

  if (!service || service.status !== "ACTIVE") {
    const err = new Error("Service not available") as any;
    err.status = 404;
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

  // Count current active queue entries
  const currentSize = await prisma.queue.count({
    where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
  });

  if (currentSize >= service.queueLimit) {
    const err = new Error("Queue is full. Please join the waitlist instead.") as any;
    err.status = 409;
    err.code = "QUEUE_FULL";
    throw err;
  }

  const position = await getNextQueuePosition(serviceId);
  const estimatedWait = service.estimatedDurationMins * (position - 1);
  const isImmediate = position === 1; // provider is free, so no Queue row is created

  // Create Booking row
  // When isImmediate (position 1, provider is free), the spec says service starts
  // immediately — so both status and started flag must reflect this.
  const booking = await prisma.booking.create({
    data: {
      seekerId,
      providerId: service.providerId,
      serviceId,
      offerId,
      paymentMethod: "GCash",
      paymentStatus: "PAID_HELD",
      status: isImmediate ? "ONGOING" : "WAITING",
      queuePosition: isImmediate ? null : position,
      started: isImmediate, // Part 9: immediate online booking starts at creation time
    },
  });

  const queueEntry = isImmediate
    ? {
        id: null,
        bookingId: booking.id,
        serviceId,
        seekerId,
        position: null,
        estimatedWait: 0,
        status: "ONGOING",
      }
    : await prisma.queue.create({
        data: {
          serviceId,
          seekerId,
          offerId,
          paymentId,
          position,
          estimatedWait,
          paymentStatus: "PAID_HELD",
          status: "WAITING",
          bookingId: booking.id,
        },
      });

  // Notify provider of new queue entry
  await prisma.notification.create({
    data: {
      userId: service.providerId,
      title: isImmediate ? "New Job Starting Now! 🚀" : "New Queue Entry",
      body: isImmediate
        ? `A new client is at position 1 for "${service.title}". Payment confirmed.`
        : `A new client joined your queue at position ${position} for "${service.title}".`,
    },
  });

  // ── Real-time: notify all clients watching this service's queue ───────────
  safeEmit(`service:${serviceId}`, "queue_update", {
    serviceId,
    delta: isImmediate ? 0 : +1,
    currentSize: isImmediate ? currentSize : currentSize + 1,
  });
  // Notify the provider in their personal room
  safeEmit(`user:${service.providerId}`, "notification", { title: isImmediate ? "New Job Starting Now! 🚀" : "New Queue Entry" });

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
    },
  });

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
    },
  });

  // ── Real-time queue update ────────────────────────────────────────────────
  safeEmit(`service:${queueEntry.serviceId}`, "queue_update", { serviceId: queueEntry.serviceId, delta: -1 });
  safeEmit(`user:${queueEntry.seekerId}`, "notification", { title: "Booking Cancelled by Provider ⚠️" });

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
    },
  });

  // ── Real-time: notify seeker to confirm ──────────────────────────────────
  safeEmit(`user:${booking.seekerId}`, "notification", { title: "Service Completed — Please Confirm ✅" });
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

  // Update trust score: successful completion gives +2 trust to provider and +1 to seeker
  // Spec Part 10: "Each booking that reaches COMPLETED via genuine seeker confirmation"
  const { applyTrustEvent } = await import("./trust.service");
  await applyTrustEvent(booking.providerId, 2, "Successful service completion (provider)");
  await applyTrustEvent(booking.seekerId, 1, "Successful service completion (seeker)");

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: booking.providerId,
      title: "Payment Confirmed 💰",
      body: booking.paymentMethod === "GCash"
        ? `₱${finalPrice} has been released to your wallet.`
        : `Seeker confirmed completion of cash-based job for ₱${finalPrice}.`,
    },
  });

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
    },
  });

  return report;
}

// ── Seeker: Join Waitlist (Notify Me When Open) ───────────────────────────────

export async function joinWaitlist(serviceId: string, seekerId: string) {
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

  if (entry.status === "SERVING") {
    await applyCancellationTrust(seekerId, false);
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
