import { prisma } from "../lib/prisma";
import { recalculateQueue, notifyWaitlist } from "./queue.service";
import { applyCancellationTrust, applyServiceCompletionTrust } from "./trust.service";
import { safeEmit } from "../lib/socket";
import { assertDistinctAccounts } from "../utils/security";
import { sendMessage } from "./messages.service";
import { refundBookingPayment } from "./payment-refund.service";
// ── FCFS Queue Logic ──────────────────────────────────────────────────────────
export async function getNextQueuePosition(serviceId) {
    const lastEntry = await prisma.queue.findFirst({
        where: { serviceId, status: "WAITING" },
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
export async function calculateEstimatedWait(serviceId, position) {
    const service = await prisma.service.findUnique({
        where: { id: serviceId },
        select: { estimatedDurationMins: true },
    });
    if (!service)
        return 0;
    return service.estimatedDurationMins * (position - 1);
}
async function resolveFinalPrice(booking) {
    if (booking.agreedAmount != null)
        return Number(booking.agreedAmount);
    if (booking.directRequest)
        return Number(booking.directRequest.agreedPrice);
    if (booking.offer)
        return Number(booking.offer.offeredPrice);
    if (booking.service)
        return Number(booking.service.price);
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
export async function createDirectRequest(params) {
    const { seekerId, providerId, serviceId, agreedPrice, schedule, message, scheduledDate, scheduledTime } = params;
    // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
    assertDistinctAccounts(seekerId, providerId, "book service");
    const service = await prisma.service.findUnique({
        where: { id: serviceId },
        select: { paymentMethods: true, isAvailable: true, title: true, status: true },
    });
    if (!service || service.status !== "ACTIVE" || !service.isAvailable) {
        const err = new Error("This service listing is currently paused by the provider and is not accepting bookings");
        err.status = 400;
        throw err;
    }
    const pm = service.paymentMethods;
    if (!pm?.cash) {
        const err = new Error("This provider does not accept cash payments");
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
        const err = new Error("You already have an active booking for this service in progress. Please check your Activity tab.");
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
                agreedAmount: agreedPrice,
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
export async function respondToDirectBookingService(requestId, providerId, accept) {
    // Check if requestId is a directRequest ID or a booking ID
    let directRequest = await prisma.directRequest.findUnique({
        where: { id: requestId },
        include: { booking: true },
    });
    let targetBooking = null;
    if (directRequest) {
        targetBooking = directRequest.booking;
    }
    else {
        targetBooking = await prisma.booking.findUnique({
            where: { id: requestId },
            include: { directRequest: true, queue: true, service: true },
        });
        if (targetBooking?.directRequest) {
            directRequest = targetBooking.directRequest;
        }
    }
    if (!directRequest && !targetBooking) {
        const err = new Error("Booking request not found");
        err.status = 404;
        throw err;
    }
    const effectiveProviderId = directRequest?.providerId || targetBooking?.providerId;
    const effectiveSeekerId = directRequest?.seekerId || targetBooking?.seekerId;
    if (effectiveProviderId !== providerId) {
        const err = new Error("Access denied");
        err.status = 403;
        throw err;
    }
    // Validate that the request or booking has not already been cancelled or declined
    if ((directRequest && directRequest.status === "DECLINED") ||
        (targetBooking && (targetBooking.status === "CANCELED" || targetBooking.status === "DECLINED" || targetBooking.status === "REMOVED"))) {
        const err = new Error("This request has already been cancelled or declined.");
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
                    seekerId: directRequest.seekerId,
                    providerId,
                    serviceId: directRequest.serviceId,
                    directRequestId: directRequest.id,
                    paymentMethod: "On-site Cash",
                    agreedAmount: directRequest.agreedPrice,
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
    }
    else {
        // Decline
        const hasHeldOnlinePayment = targetBooking && ["PAID_HELD", "FROZEN_HELD"].includes(targetBooking.paymentStatus);
        if (hasHeldOnlinePayment) {
            await refundBookingPayment(targetBooking.id, providerId, "Full refund because the provider declined the paid booking request");
        }
        const updated = await prisma.$transaction(async (tx) => {
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
export async function createDirectFromOfferService(offerId, seekerId) {
    const offer = await prisma.offer.findUnique({
        where: { id: offerId },
        include: { request: true }
    });
    if (!offer || offer.request.seekerId !== seekerId) {
        const err = new Error("Offer not found or access denied");
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
// ── Online Queue Entry (ONLY after PayMongo payment succeeds) ─────────────────
export async function addToQueue(params) {
    const result = await prisma.$transaction(async (tx) => {
        // Serialize reservations per service. PostgreSQL releases this advisory
        // lock at transaction end, so independent services remain concurrent.
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${params.serviceId}))`;
        // A retried confirmation for an already-consumed payment intent is
        // idempotent and cannot reserve an additional queue slot.
        const existing = await tx.queue.findUnique({ where: { paymentId: params.paymentId } });
        if (existing)
            return { queueEntry: existing, isImmediate: existing.position === 1, booking: null, service: null, currentSize: 0 };
        return addToQueueLocked(params, tx);
    });
    if (!result.booking || !result.service) {
        return { queueEntry: result.queueEntry, isImmediate: result.isImmediate };
    }
    const { queueEntry, booking, service, currentSize, isImmediate } = result;
    await sendMessage(booking.id, params.seekerId, "Payment received and held in Escrow.", undefined, true);
    await prisma.notification.create({
        data: {
            userId: service.providerId,
            title: "New Paid Booking Request! ðŸ”’",
            body: `A client requested "${service.title}" with payment secured in Escrow via ${params.paymentMethod || "online payment"}. Review and accept.`,
            link: `/provider/provider-activity?tab=waiting&booking=${booking.id}`,
        },
    });
    safeEmit(`service:${params.serviceId}`, "queue_update", { serviceId: params.serviceId, delta: +1, currentSize: currentSize + 1 });
    safeEmit(`user:${service.providerId}`, "notification", { title: "New Paid Booking Request! ðŸ”’" });
    safeEmit(`user:${service.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "queue_created" });
    safeEmit(`user:${params.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "queue_created" });
    return { queueEntry, isImmediate };
}
async function addToQueueLocked(params, tx) {
    const { serviceId, seekerId, paymentId, paymongoPaymentId, amount, offerId, scheduledDate, scheduledTime, paymentMethod } = params;
    const service = await tx.service.findUnique({
        where: { id: serviceId },
        select: { queueLimit: true, estimatedDurationMins: true, isAvailable: true, title: true, status: true, providerId: true },
    });
    // The caller reaches this function only after PayMongo confirms capture.
    // Preserve a durable booking/payment link even if availability changed
    // between payment initiation and the asynchronous confirmation callback.
    if (!service) {
        const err = new Error("The paid service no longer exists; manual payment reconciliation is required");
        err.status = 409;
        throw err;
    }
    // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
    if (seekerId === service.providerId) {
        const err = new Error("You cannot book or send an offer on your own service listing or request.");
        err.status = 403;
        err.code = "SELF_TRANSACTION_NOT_ALLOWED";
        throw err;
    }
    if (offerId) {
        const offer = await tx.offer.findUnique({
            where: { id: offerId },
            include: { request: true },
        });
        if (!offer || offer.status !== "ACCEPTED" || offer.request.seekerId !== seekerId || offer.providerId !== service.providerId) {
            const err = new Error("Accepted offer does not match this online booking");
            err.status = 400;
            throw err;
        }
    }
    // Count total load (active ongoing booking + queued entries)
    const activeOngoingCount = await tx.booking.count({
        where: { serviceId, status: "ONGOING" },
    });
    const queueCount = await tx.queue.count({
        where: { serviceId, status: "WAITING" },
    });
    const currentSize = activeOngoingCount + queueCount;
    // Capacity is checked before the payment intent is created. If a race fills
    // the last slot after capture, retain the paid booking instead of stranding
    // money without a local record; it becomes the next waiting position.
    const lastEntry = await tx.queue.findFirst({
        where: { serviceId, status: "WAITING" },
        orderBy: { position: "desc" },
    });
    const position = lastEntry ? lastEntry.position + 1 : (activeOngoingCount > 0 ? 2 : 1);
    const estimatedWait = service.estimatedDurationMins * (position - 1);
    const isImmediate = position === 1;
    // Online booking with Escrow (PAID_HELD):
    // Work NEVER starts automatically. If there's an accepted offer (Flow B), status is ACCEPTED.
    // If direct booking on a listing (Flow A), status is PENDING_APPROVAL awaiting provider review.
    // started is ALWAYS false until provider clicks Start Job.
    const booking = await tx.booking.create({
        data: {
            seekerId,
            providerId: service.providerId,
            serviceId,
            offerId,
            paymentMethod: paymentMethod || "GCash",
            agreedAmount: amount,
            paymentStatus: "PAID_HELD",
            status: offerId ? "ACCEPTED" : "PENDING_APPROVAL",
            queuePosition: position,
            started: false,
            scheduledDate: scheduledDate || null,
            scheduledTime: scheduledTime || null,
        },
    });
    const queueEntry = await tx.queue.create({
        data: {
            serviceId,
            seekerId,
            offerId: offerId || null,
            paymentId,
            paymongoPaymentId: paymongoPaymentId || null,
            position,
            estimatedWait,
            paymentStatus: "PAID_HELD",
            status: "WAITING",
            bookingId: booking.id,
        },
    });
    /*
    // Notifications and socket events must run after the transaction commits.
    // Kept below as the source for the post-commit handling in addToQueue.
    // Notify provider of new paid booking request
    await prisma.notification.create({
      data: {
        userId: service.providerId,
        title: "New Paid Booking Request! 🔒",
        body: `A client requested "${service.title}" with payment secured in Escrow via GCash. Review and accept.`,
        link: `/provider/provider-activity?tab=waiting&booking=${booking.id}`,
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
  
    */
    return { queueEntry, booking, service, currentSize, isImmediate };
}
// ── Provider Start Job ────────────────────────────────────────────────────────
export async function providerStartJob(id, providerId) {
    const result = await prisma.$transaction(async (tx) => {
        let booking = await tx.booking.findUnique({ where: { id }, include: { queue: true } });
        let queueEntry = booking?.queue ?? null;
        if (!booking) {
            const entry = await tx.queue.findUnique({ where: { id }, include: { booking: { include: { queue: true } } } });
            booking = entry?.booking ?? null;
            queueEntry = entry ?? null;
        }
        if (!booking || booking.providerId !== providerId) {
            const err = new Error("Booking or queue entry not found or access denied");
            err.status = 404;
            throw err;
        }
        if (booking.status !== "ACCEPTED") {
            const err = new Error("Only an accepted booking can be started.");
            err.status = 400;
            throw err;
        }
        if (queueEntry) {
            await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtext(${queueEntry.serviceId}))`;
            const firstWaiting = await tx.queue.findFirst({
                where: { serviceId: queueEntry.serviceId, status: "WAITING" },
                orderBy: { position: "asc" },
                select: { id: true },
            });
            const ongoing = await tx.booking.count({ where: { serviceId: queueEntry.serviceId, status: "ONGOING" } });
            if (firstWaiting?.id !== queueEntry.id || ongoing > 0) {
                const err = new Error("Start the first waiting booking after the current job is completed.");
                err.status = 409;
                throw err;
            }
            // Keep the payment intent/payment ID linked throughout service and
            // dispute handling. Deleting this row made later refunds impossible.
            await tx.queue.update({
                where: { id: queueEntry.id },
                data: { status: "SERVING", position: 1, estimatedWait: 0 },
            });
        }
        const updatedBooking = await tx.booking.update({
            where: { id: booking.id },
            data: { status: "ONGOING", started: true },
        });
        return { booking: updatedBooking, queueEntry };
    });
    const { booking, queueEntry } = result;
    if (queueEntry) {
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
    return booking;
}
// ── Provider Remove Queue Entry ───────────────────────────────────────────────
export async function providerRemoveQueueEntry(queueId, providerId) {
    const queueEntry = await prisma.queue.findUnique({
        where: { id: queueId },
        include: { service: true }
    });
    if (!queueEntry || queueEntry.service.providerId !== providerId) {
        const err = new Error("Queue entry not found or access denied");
        err.status = 404;
        throw err;
    }
    if (["DONE", "CANCELLED", "REMOVED"].includes(queueEntry.status)) {
        const err = new Error("This queue booking can no longer be removed");
        err.status = 409;
        throw err;
    }
    if (!queueEntry.bookingId) {
        const err = new Error("Paid queue entry is missing its booking");
        err.status = 409;
        throw err;
    }
    await refundBookingPayment(queueEntry.bookingId, providerId, "Full refund because the provider cancelled the queue booking");
    // Update Queue status to REMOVED
    await prisma.queue.update({
        where: { id: queueId },
        data: { status: "REMOVED", paymentStatus: "REFUNDED" }
    });
    // Update corresponding Booking status to REMOVED
    if (queueEntry.bookingId) {
        await prisma.booking.update({
            where: { id: queueEntry.bookingId },
            data: { status: "REMOVED", paymentStatus: "REFUNDED" }
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
            body: "The provider removed your booking from their queue. Your PayMongo refund was submitted.",
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
export async function markJobComplete(id, providerId) {
    // Find booking or queue entry
    let booking = await prisma.booking.findUnique({
        where: { id },
        include: { queue: true }
    });
    let queueEntry = null;
    if (!booking) {
        // Maybe the passed ID is a queue ID
        queueEntry = await prisma.queue.findUnique({
            where: { id },
            include: { booking: true }
        });
        if (queueEntry) {
            booking = queueEntry.booking;
        }
    }
    else {
        queueEntry = booking.queue;
    }
    if (!booking) {
        const err = new Error("Booking or queue entry not found");
        err.status = 404;
        throw err;
    }
    // Verify provider
    if (booking.providerId !== providerId) {
        const err = new Error("Access denied");
        err.status = 403;
        throw err;
    }
    if (booking.status !== "ONGOING") {
        const err = new Error("Only ongoing jobs can be marked completed");
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
    if (queueEntry)
        safeEmit(`service:${queueEntry.serviceId}`, "queue_update", { serviceId: queueEntry.serviceId, delta: 0 });
    return booking;
}
// ── Seeker: Confirm Completion (release escrow) ───────────────────────────────
export async function confirmCompletionService(bookingId, seekerId) {
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { queue: true, directRequest: true, offer: true, service: true }
    });
    if (!booking || booking.seekerId !== seekerId) {
        const err = new Error("Booking not found or access denied");
        err.status = 404;
        throw err;
    }
    if (booking.status !== "AWAITING_CONFIRMATION") {
        const err = new Error("Completion can only be confirmed after the provider marks the job completed");
        err.status = 400;
        throw err;
    }
    const finalPrice = await resolveFinalPrice(booking);
    const isOnlinePayment = booking.paymentMethod !== "On-site Cash";
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
    if (booking.queue) {
        await prisma.queue.update({
            where: { id: booking.queue.id },
            data: { status: "DONE", paymentStatus: "RELEASED" },
        });
    }
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
    if (isOnlinePayment) {
        await sendMessage(booking.id, seekerId, "Funds released.", undefined, true);
    }
    else {
        await sendMessage(booking.id, seekerId, "Transaction completed.", undefined, true);
    }
    // Release escrow / log earning transaction for provider
    await prisma.transaction.create({
        data: {
            walletOwnerId: booking.providerId,
            type: "EARNING",
            amount: finalPrice,
            relatedBookingId: completedService.id,
            description: isOnlinePayment
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
            body: isOnlinePayment
                ? `₱${finalPrice} has been released to your wallet.`
                : `Seeker confirmed completion of cash-based job for ₱${finalPrice}.`,
            link: `/provider/provider-activity?tab=all&booking=${booking.id}`,
        },
    });
    safeEmit(`user:${booking.providerId}`, "notification", { title: "Payment Confirmed 💰" });
    safeEmit(`user:${booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "completed" });
    safeEmit(`user:${booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "completed" });
    safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "completed" });
    if (booking.queue) {
        await recalculateQueue(booking.queue.serviceId);
        await notifyWaitlist(booking.queue.serviceId);
    }
    return completedService;
}
// ── Seeker: Dispute Job ───────────────────────────────────────────────────────
export async function disputeJobService(bookingId, seekerId, reason, description, evidenceUrl) {
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId }
    });
    if (!booking || booking.seekerId !== seekerId) {
        const err = new Error("Booking not found or access denied");
        err.status = 404;
        throw err;
    }
    if (booking.status !== "AWAITING_CONFIRMATION") {
        const err = new Error("A dispute can only be filed while the booking is awaiting seeker confirmation");
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
    let reportReason = "POOR_SERVICE_QUALITY";
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
export async function joinWaitlist(serviceId, seekerId) {
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
        const err = new Error("You already have an active booking for this service in progress. Please check your Activity tab.");
        err.status = 400;
        throw err;
    }
    // Check if already on waitlist
    const existing = await prisma.queueNotify.findUnique({
        where: { serviceId_seekerId: { serviceId, seekerId } },
    });
    if (existing) {
        const err = new Error("You are already on the waitlist for this service");
        err.status = 409;
        throw err;
    }
    return prisma.queueNotify.create({ data: { serviceId, seekerId } });
}
// ── Seeker: Cancel Queue Entry ────────────────────────────────────────────────
export async function cancelQueueEntry(queueId, seekerId) {
    const entry = await prisma.queue.findUnique({
        where: { id: queueId },
        select: { id: true, seekerId: true, serviceId: true, status: true, paymentId: true, paymentStatus: true, bookingId: true }
    });
    if (!entry || entry.seekerId !== seekerId) {
        const err = new Error("Queue entry not found");
        err.status = 404;
        throw err;
    }
    if (entry.status === "DONE") {
        const err = new Error("Cannot cancel a completed job");
        err.status = 400;
        throw err;
    }
    if (entry.status === "CANCELLED")
        return { cancelled: true, alreadyCancelled: true };
    if (entry.status === "REMOVED") {
        const err = new Error("This booking was already removed by the provider");
        err.status = 409;
        throw err;
    }
    const hasHeldOnlinePayment = ["PAID_HELD", "FROZEN_HELD"].includes(entry.paymentStatus);
    if (hasHeldOnlinePayment) {
        if (!entry.bookingId) {
            const err = new Error("Paid queue entry is missing its booking");
            err.status = 409;
            throw err;
        }
        await refundBookingPayment(entry.bookingId, seekerId, "Full refund for cancelled queue booking");
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
    if (!hasHeldOnlinePayment) {
        await prisma.queue.update({
            where: { id: queueId },
            data: { status: "CANCELLED", paymentStatus: entry.paymentStatus },
        });
    }
    if (entry.bookingId) {
        if (!hasHeldOnlinePayment) {
            await prisma.booking.update({
                where: { id: entry.bookingId },
                data: { status: "CANCELED", paymentStatus: "UNPAID" },
            });
        }
        await sendMessage(entry.bookingId, seekerId, "Booking cancelled.", undefined, true);
    }
    await recalculateQueue(entry.serviceId);
    await notifyWaitlist(entry.serviceId);
    // ── Real-time queue update ────────────────────────────────────────────────
    safeEmit(`service:${entry.serviceId}`, "queue_update", { serviceId: entry.serviceId, delta: -1 });
    return { cancelled: true };
}
// ── Hide / Dismiss Booking from User View ─────────────────────────────────────
export async function hideBookingService(bookingId, userId) {
    const booking = await prisma.booking.findUnique({
        where: { id: bookingId }
    });
    if (!booking) {
        const err = new Error("Booking not found");
        err.status = 404;
        throw err;
    }
    if (booking.seekerId !== userId && booking.providerId !== userId) {
        const err = new Error("Access denied");
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
//# sourceMappingURL=bookings.service.js.map