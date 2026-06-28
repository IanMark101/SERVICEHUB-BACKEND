import { prisma } from "../lib/prisma";
import { recalculateQueue, notifyWaitlist } from "./queue.service";

// ── Perform Immediate Cancel & Process Refund/Escrow ──────────────────────────
export async function performImmediateCancel(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { queue: true, service: true, offer: true, directRequest: true }
  });
  if (!booking) return;

  // Determine the correct refund status:
  // - If payment was held (online), issue a full refund → REFUNDED
  // - Otherwise keep the existing status (UNPAID for cash, etc.)
  const newPaymentStatus = booking.paymentStatus === "PAID_HELD" ? "REFUNDED" : booking.paymentStatus;

  // Update Booking status to CANCELED
  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: "CANCELED",
      paymentStatus: newPaymentStatus
    }
  });

  if (booking.queue) {
    await prisma.queue.update({
      where: { id: booking.queue.id },
      data: {
        status: "CANCELLED",
        paymentStatus: booking.queue.paymentStatus === "PAID_HELD" ? "REFUNDED" : booking.queue.paymentStatus
      }
    });

    // Recalculate queue and notify waitlist
    await recalculateQueue(booking.queue.serviceId);
    await notifyWaitlist(booking.queue.serviceId);
  }

  // If an online payment was refunded, create a REFUND transaction record
  if (booking.paymentStatus === "PAID_HELD") {
    // Determine the refund amount
    let refundAmount = 0;
    if (booking.directRequest) {
      refundAmount = Number(booking.directRequest.agreedPrice);
    } else if (booking.offer) {
      refundAmount = Number(booking.offer.offeredPrice);
    } else if (booking.service) {
      refundAmount = Number(booking.service.price);
    }

    if (refundAmount > 0) {
      await prisma.transaction.create({
        data: {
          walletOwnerId: booking.seekerId,
          type: "REFUND",
          amount: refundAmount,
          relatedBookingId: booking.id,
          description: "Full refund for cancelled booking",
        },
      });
    }
  }

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: booking.providerId,
      title: "Booking Cancelled ⚠️",
      body: "The booking has been cancelled.",
    }
  });

  // Notify seeker about the refund (if online payment)
  if (booking.paymentStatus === "PAID_HELD") {
    await prisma.notification.create({
      data: {
        userId: booking.seekerId,
        title: "Refund Processed 💰",
        body: "Your online payment has been fully refunded due to the cancellation.",
      }
    });
  }
}

// ── Request Cancellation ───────────────────────────────────────────────────────
export async function requestCancellation(bookingId: string, seekerId: string, reason?: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking || booking.seekerId !== seekerId) {
    const err = new Error("Booking not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (booking.started === false) {
    // Seeker can cancel anytime instantly
    await performImmediateCancel(bookingId);
    return { cancelled: true, immediate: true };
  } else {
    // started === true -> create CancellationRequest with status: PENDING
    const existing = await prisma.cancellationRequest.findFirst({
      where: { bookingId, status: "PENDING" }
    });

    if (existing) {
      const err = new Error("A cancellation request is already pending for this booking") as any;
      err.status = 409;
      throw err;
    }

    const cancelReq = await prisma.cancellationRequest.create({
      data: {
        bookingId,
        requestedBy: seekerId,
        reason,
        status: "PENDING"
      }
    });

    // Notify provider
    await prisma.notification.create({
      data: {
        userId: booking.providerId,
        title: "Cancellation Request Received ⚠️",
        body: `The seeker has requested to cancel your active booking. Please review and respond in your activity tab.`,
      }
    });

    return { cancelled: false, immediate: false, request: cancelReq };
  }
}

// ── Respond to Cancellation Request (Provider Action) ─────────────────────────
export async function respondToCancellationRequest(
  requestId: string, 
  providerId: string, 
  approve: boolean, 
  providerNote?: string
) {
  const cancelReq = await prisma.cancellationRequest.findUnique({
    where: { id: requestId },
    include: { booking: true }
  });

  if (!cancelReq || cancelReq.booking.providerId !== providerId) {
    const err = new Error("Cancellation request not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (cancelReq.status !== "PENDING") {
    const err = new Error("Cancellation request has already been resolved") as any;
    err.status = 400;
    throw err;
  }

  if (approve) {
    await prisma.cancellationRequest.update({
      where: { id: requestId },
      data: { 
        status: "APPROVED",
        resolvedAt: new Date()
      }
    });

    await performImmediateCancel(cancelReq.bookingId);

    // Notify seeker
    await prisma.notification.create({
      data: {
        userId: cancelReq.booking.seekerId,
        title: "Cancellation Request Approved 🎉",
        body: "The provider has approved your cancellation request. Payout is refunded/cancelled.",
      }
    });

    return { resolved: true, approved: true };
  } else {
    const updated = await prisma.cancellationRequest.update({
      where: { id: requestId },
      data: {
        status: "DECLINED",
        providerNote,
        resolvedAt: new Date()
      }
    });

    // Notify seeker
    await prisma.notification.create({
      data: {
        userId: cancelReq.booking.seekerId,
        title: "Cancellation Request Declined ❌",
        body: `The provider declined your cancellation request. Reason: "${providerNote || "No reason provided"}". You can escalate to Admin if needed.`,
      }
    });

    return { resolved: true, approved: false, request: updated };
  }
}

// ── Escalate Cancellation Request (Seeker Action) ──────────────────────────────
export async function escalateCancellationRequest(requestId: string, seekerId: string) {
  const cancelReq = await prisma.cancellationRequest.findUnique({
    where: { id: requestId },
    include: { booking: true }
  });

  if (!cancelReq || cancelReq.booking.seekerId !== seekerId) {
    const err = new Error("Cancellation request not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (cancelReq.status !== "DECLINED") {
    const err = new Error("Only declined cancellation requests can be escalated") as any;
    err.status = 400;
    throw err;
  }

  const updated = await prisma.cancellationRequest.update({
    where: { id: requestId },
    data: { status: "ESCALATED" }
  });

  // Create standard dispute Report case
  await prisma.report.create({
    data: {
      bookingId: cancelReq.bookingId,
      reporterId: seekerId,
      reportedUserId: cancelReq.booking.providerId,
      reason: "INCOMPLETE_SERVICE",
      description: `Cancellation request escalated. Seeker requested cancellation. Reason: "${cancelReq.reason || 'No reason provided'}". Provider declined with note: "${cancelReq.providerNote || 'No reason provided'}".`,
      status: "PENDING"
    }
  });

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: cancelReq.booking.providerId,
      title: "Cancellation Escalated to Admin ⚠️",
      body: "The seeker has escalated their declined cancellation request to a Moderator/Admin.",
    }
  });

  return updated;
}

// ── Resolve Cancellation Request (Admin/Moderator Action) ─────────────────────
export async function adminResolveCancellationRequest(
  requestId: string, 
  approve: boolean, 
  adminNote?: string
) {
  const cancelReq = await prisma.cancellationRequest.findUnique({
    where: { id: requestId },
    include: { booking: true }
  });

  if (!cancelReq) {
    const err = new Error("Cancellation request not found") as any;
    err.status = 404;
    throw err;
  }

  if (cancelReq.status !== "ESCALATED") {
    const err = new Error("Only escalated cancellation requests can be resolved by admin") as any;
    err.status = 400;
    throw err;
  }

  // Update request status to RESOLVED
  const updatedRequest = await prisma.cancellationRequest.update({
    where: { id: requestId },
    data: {
      status: "RESOLVED",
      adminNote,
      resolvedAt: new Date()
    }
  });

  // Update associated Reports to RESOLVED
  await prisma.report.updateMany({
    where: { bookingId: cancelReq.bookingId, status: { in: ["PENDING", "UNDER_REVIEW"] } },
    data: {
      status: "RESOLVED",
      adminNotes: `Resolved via cancellation request flow: ${adminNote || ""}`,
      resolvedAt: new Date()
    }
  });

  if (approve) {
    await performImmediateCancel(cancelReq.bookingId);

    // Notify both parties
    await prisma.notification.createMany({
      data: [
        {
          userId: cancelReq.booking.seekerId,
          title: "Admin Resolved Cancellation in your favor 🎉",
          body: `Admin approved your cancellation request. ${adminNote || ""}`,
        },
        {
          userId: cancelReq.booking.providerId,
          title: "Admin Cancelled Booking ⚠️",
          body: `Admin approved the seeker's cancellation request. ${adminNote || ""}`,
        }
      ]
    });
  } else {
    // Reject cancellation request -> booking stays as-is (ONGOING)
    await prisma.notification.createMany({
      data: [
        {
          userId: cancelReq.booking.seekerId,
          title: "Admin Rejected Cancellation Request",
          body: `Admin rejected your cancellation escalation. Booking will continue as ongoing. ${adminNote || ""}`,
        },
        {
          userId: cancelReq.booking.providerId,
          title: "Admin Ruled in your favor on cancellation",
          body: `Admin rejected the seeker's cancellation escalation. The booking remains ongoing. ${adminNote || ""}`,
        }
      ]
    });
  }

  return updatedRequest;
}
