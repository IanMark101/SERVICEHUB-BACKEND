import { prisma } from "../../lib/prisma";
import { safeEmit } from "../../lib/socket";
import { assertDistinctAccounts } from "../../utils/security";
import { sendMessage } from "../messages.service";
import { refundBookingPayment } from "../payment-refund.service";
// ── Cash Direct Request (no queue) ────────────────────────────────────────────

export async function createDirectRequest(params: {
  seekerId: string;
  providerId: string;
  serviceId: string;
  schedule?: string;
  message?: string;
  scheduledDate?: string; // ISO date e.g. "2026-08-15" — for session-based services
  scheduledTime?: string; // HH:MM e.g. "16:00" — for session-based services
}) {
  const { seekerId, providerId, serviceId, schedule, message, scheduledDate, scheduledTime } = params;

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
  assertDistinctAccounts(seekerId, providerId, "book service");

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: {
      providerId: true,
      paymentMethods: true,
      price: true,
      priceType: true,
      serviceType: true,
      isAvailable: true,
      title: true,
      status: true,
      provider: { select: { isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true } },
    },
  });

  if (!service || service.providerId !== providerId || service.status !== "ACTIVE" || !service.isAvailable) {
    const err = new Error("This service listing is currently paused by the provider and is not accepting bookings") as any;
    err.status = 400;
    throw err;
  }

  if (service.priceType !== "FIXED") {
    const err = new Error("Direct cash booking is available only for fixed-price listings") as any;
    err.status = 400;
    throw err;
  }
  if (service.price === null) {
    const err = new Error("This fixed-price listing is missing a valid price") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  const fixedPrice = service.price;
  if (service.serviceType !== "ONE_TIME") {
    const err = new Error("Session booking is not available until conflict-safe scheduling is enabled") as any;
    err.status = 409;
    err.code = "SESSION_SCHEDULING_NOT_AVAILABLE";
    throw err;
  }
  if (!service.provider.isActive || service.provider.moderationStatus !== "ACTIVE" || !service.provider.emailVerified || service.provider.verificationStatus !== "APPROVED") {
    const err = new Error("The provider is not currently eligible to accept a new booking") as any;
    err.status = 409;
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`direct-booking:${seekerId}:${serviceId}`}))`;
    const concurrentBooking = await tx.booking.findFirst({
      where: { seekerId, serviceId, status: { in: ["PENDING_APPROVAL", "ACCEPTED", "WAITING", "ONGOING", "AWAITING_CONFIRMATION", "DISPUTED"] } },
      select: { id: true },
    });
    if (concurrentBooking) {
      const err = new Error("You already have an active booking for this service") as any;
      err.status = 409;
      throw err;
    }
    const directRequest = await tx.directRequest.create({
      data: {
        seekerId,
        providerId,
        serviceId,
        selectedPaymentMethod: "cash",
        agreedPrice: fixedPrice,
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
        originType: "DIRECT_LISTING",
        paymentMethod: "On-site Cash",
        agreedAmount: fixedPrice,
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
      link: `/provider/incoming-requests?booking=${booking.id}`,
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

  if ((directRequest && directRequest.status !== "PENDING_APPROVAL") || (targetBooking && targetBooking.status !== "PENDING_APPROVAL")) {
    const err = new Error("This booking request has already been processed") as any;
    err.status = 409;
    throw err;
  }

  if (accept) {
    const booking = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`direct-response:${directRequest?.id || targetBooking?.id}`}))`;
      if (directRequest) {
        const freshRequest = await tx.directRequest.findUnique({ where: { id: directRequest.id }, select: { status: true } });
        if (freshRequest?.status !== "PENDING_APPROVAL") {
          const err = new Error("This booking request has already been processed") as any;
          err.status = 409;
          throw err;
        }
      }
      if (targetBooking) {
        const freshBooking = await tx.booking.findUnique({ where: { id: targetBooking.id }, select: { status: true } });
        if (freshBooking?.status !== "PENDING_APPROVAL") {
          const err = new Error("This booking request has already been processed") as any;
          err.status = 409;
          throw err;
        }
      }
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
          agreedAmount: directRequest!.agreedPrice,
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
    const hasHeldOnlinePayment = targetBooking && ["PAID_HELD", "FROZEN_HELD"].includes(targetBooking.paymentStatus);
    if (hasHeldOnlinePayment) {
      await refundBookingPayment(
        targetBooking.id,
        providerId,
        "Full refund because the provider declined the paid booking request",
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`direct-response:${directRequest?.id || targetBooking?.id}`}))`;
      if (directRequest) {
        const freshRequest = await tx.directRequest.findUnique({ where: { id: directRequest.id }, select: { status: true } });
        if (freshRequest?.status !== "PENDING_APPROVAL") {
          const err = new Error("This booking request has already been processed") as any;
          err.status = 409;
          throw err;
        }
      }
      if (targetBooking) {
        const freshBooking = await tx.booking.findUnique({ where: { id: targetBooking.id }, select: { status: true } });
        if (freshBooking?.status !== "PENDING_APPROVAL") {
          const err = new Error("This booking request has already been processed") as any;
          err.status = 409;
          throw err;
        }
      }
      if (directRequest) {
        await tx.directRequest.update({
          where: { id: directRequest.id },
          data: { status: "DECLINED" },
        });
      }

      if (targetBooking) {
        return tx.booking.update({
          where: { id: targetBooking.id },
          data: {
            status: "DECLINED",
            paymentStatus: hasHeldOnlinePayment ? "REFUNDED" : targetBooking.paymentStatus,
          },
        });
      }

      return null;
    });

    await prisma.notification.create({
      data: {
        userId: effectiveSeekerId,
        title: "Booking Request Declined ❌",
        body: hasHeldOnlinePayment
          ? "Your booking request was declined by the provider. Your PayMongo refund was submitted."
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

  if (offer.status !== "PENDING" || offer.request.status !== "OPEN" || !offer.serviceId) {
    const err = new Error("This offer is no longer available or is missing its provider listing") as any;
    err.status = 409;
    throw err;
  }

  const service = await prisma.service.findUnique({
    where: { id: offer.serviceId },
    select: {
      providerId: true,
      categoryId: true,
      status: true,
      isAvailable: true,
      serviceType: true,
      paymentMethods: true,
      provider: {
        select: {
          isActive: true,
          moderationStatus: true,
          emailVerified: true,
          verificationStatus: true,
        },
      },
    },
  });
  const methods = service?.paymentMethods as { cash?: boolean } | undefined;
  if (!service || service.providerId !== offer.providerId || service.categoryId !== offer.request.categoryId || service.status !== "ACTIVE" || !service.isAvailable || service.serviceType !== "ONE_TIME" || !methods?.cash || !service.provider.isActive || service.provider.moderationStatus !== "ACTIVE" || !service.provider.emailVerified || service.provider.verificationStatus !== "APPROVED") {
    const err = new Error("The offer's provider listing is not eligible for a cash booking") as any;
    err.status = 409;
    throw err;
  }

  const booking = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offer-selection:${offerId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${offer.requestId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`direct-booking:${seekerId}:${offer.serviceId}`}))`;

    const activeBooking = await tx.booking.findFirst({
      where: {
        seekerId,
        serviceId: offer.serviceId,
        status: { in: ["PENDING_APPROVAL", "ACCEPTED", "WAITING", "ONGOING", "AWAITING_CONFIRMATION", "DISPUTED"] },
      },
      select: { id: true },
    });
    if (activeBooking) {
      const err = new Error("You already have an active booking for this service") as any;
      err.status = 409;
      err.code = "ACTIVE_BOOKING_EXISTS";
      throw err;
    }

    const eligibleService = await tx.service.findUnique({
      where: { id: offer.serviceId! },
      select: {
        providerId: true,
        categoryId: true,
        status: true,
        isAvailable: true,
        serviceType: true,
        paymentMethods: true,
        provider: {
          select: {
            isActive: true,
            moderationStatus: true,
            emailVerified: true,
            verificationStatus: true,
          },
        },
      },
    });
    const currentMethods = eligibleService?.paymentMethods as { cash?: boolean } | undefined;
    if (!eligibleService || eligibleService.providerId !== offer.providerId || eligibleService.categoryId !== offer.request.categoryId || eligibleService.status !== "ACTIVE" || !eligibleService.isAvailable || eligibleService.serviceType !== "ONE_TIME" || !currentMethods?.cash || !eligibleService.provider.isActive || eligibleService.provider.moderationStatus !== "ACTIVE" || !eligibleService.provider.emailVerified || eligibleService.provider.verificationStatus !== "APPROVED") {
      const err = new Error("The offer's provider listing is no longer eligible for a cash booking") as any;
      err.status = 409;
      throw err;
    }

    const selected = await tx.offer.updateMany({
      where: { id: offerId, status: "PENDING" },
      data: { status: "ACCEPTED" },
    });
    if (selected.count !== 1) {
      const err = new Error("This offer was already processed") as any;
      err.status = 409;
      throw err;
    }

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
        serviceId: offer.serviceId,
        offerId: offer.id,
        originType: "OFFER",
        paymentMethod: "On-site Cash",
        agreedAmount: offer.offeredPrice,
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
