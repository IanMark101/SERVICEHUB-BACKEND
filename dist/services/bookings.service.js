"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNextQueuePosition = getNextQueuePosition;
exports.calculateEstimatedWait = calculateEstimatedWait;
exports.createDirectRequest = createDirectRequest;
exports.respondToDirectBookingService = respondToDirectBookingService;
exports.createDirectFromOfferService = createDirectFromOfferService;
exports.addToQueue = addToQueue;
exports.providerStartJob = providerStartJob;
exports.providerRemoveQueueEntry = providerRemoveQueueEntry;
exports.markJobComplete = markJobComplete;
exports.confirmCompletionService = confirmCompletionService;
exports.disputeJobService = disputeJobService;
exports.joinWaitlist = joinWaitlist;
exports.cancelQueueEntry = cancelQueueEntry;
const prisma_1 = require("../lib/prisma");
const queue_service_1 = require("./queue.service");
const trust_service_1 = require("./trust.service");
// ── FCFS Queue Logic ──────────────────────────────────────────────────────────
async function getNextQueuePosition(serviceId) {
    const lastEntry = await prisma_1.prisma.queue.findFirst({
        where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
        orderBy: { position: "desc" },
    });
    return (lastEntry?.position ?? 0) + 1;
}
async function calculateEstimatedWait(serviceId, position) {
    const service = await prisma_1.prisma.service.findUnique({
        where: { id: serviceId },
        select: { estimatedDurationMins: true },
    });
    if (!service)
        return 0;
    return service.estimatedDurationMins * (position - 1);
}
// ── Cash Direct Request (no queue) ────────────────────────────────────────────
async function createDirectRequest(params) {
    const { seekerId, providerId, serviceId, agreedPrice, schedule, message } = params;
    const service = await prisma_1.prisma.service.findUnique({
        where: { id: serviceId },
        select: { paymentMethods: true, isAvailable: true, title: true, status: true },
    });
    if (!service || service.status !== "ACTIVE") {
        const err = new Error("Service not found or not available");
        err.status = 404;
        throw err;
    }
    const pm = service.paymentMethods;
    if (!pm?.cash) {
        const err = new Error("This provider does not accept cash payments");
        err.status = 400;
        throw err;
    }
    const directRequest = await prisma_1.prisma.directRequest.create({
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
    // Notify provider
    await prisma_1.prisma.notification.create({
        data: {
            userId: providerId,
            title: "New Direct Booking Request",
            body: `A new Direct Arrangement booking request has arrived for "${service.title}". Review it in Incoming Requests.`,
        },
    });
    return directRequest;
}
// ── Respond to Direct Booking (Accept / Decline) ──────────────────────────────
async function respondToDirectBookingService(requestId, providerId, accept) {
    const directRequest = await prisma_1.prisma.directRequest.findUnique({
        where: { id: requestId }
    });
    if (!directRequest || directRequest.providerId !== providerId) {
        const err = new Error("Direct request not found or access denied");
        err.status = 404;
        throw err;
    }
    if (accept) {
        await prisma_1.prisma.directRequest.update({
            where: { id: requestId },
            data: { status: "ACCEPTED" }
        });
        const booking = await prisma_1.prisma.booking.create({
            data: {
                seekerId: directRequest.seekerId,
                providerId,
                serviceId: directRequest.serviceId,
                directRequestId: directRequest.id,
                paymentMethod: "On-site Cash",
                paymentStatus: "UNPAID",
                status: "ACCEPTED"
            }
        });
        await prisma_1.prisma.notification.create({
            data: {
                userId: directRequest.seekerId,
                title: "Direct Booking Accepted! 🎉",
                body: "Your direct booking request has been accepted. Coordinate with the provider via chat.",
            },
        });
        return booking;
    }
    else {
        const updatedRequest = await prisma_1.prisma.directRequest.update({
            where: { id: requestId },
            data: { status: "DECLINED" }
        });
        await prisma_1.prisma.notification.create({
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
async function createDirectFromOfferService(offerId, seekerId) {
    const offer = await prisma_1.prisma.offer.findUnique({
        where: { id: offerId },
        include: { request: true }
    });
    if (!offer || offer.request.seekerId !== seekerId) {
        const err = new Error("Offer not found or access denied");
        err.status = 404;
        throw err;
    }
    // Update accepted offer
    await prisma_1.prisma.offer.update({
        where: { id: offerId },
        data: { status: "ACCEPTED" }
    });
    // Reject sibling offers
    await prisma_1.prisma.offer.updateMany({
        where: {
            requestId: offer.requestId,
            id: { not: offerId }
        },
        data: { status: "REJECTED" }
    });
    // Mark request as IN_PROGRESS
    await prisma_1.prisma.serviceRequest.update({
        where: { id: offer.requestId },
        data: { status: "IN_PROGRESS" }
    });
    // Create Booking row
    const booking = await prisma_1.prisma.booking.create({
        data: {
            seekerId,
            providerId: offer.providerId,
            offerId: offer.id,
            paymentMethod: "On-site Cash",
            paymentStatus: "UNPAID",
            status: "ACCEPTED"
        }
    });
    // Notify provider
    await prisma_1.prisma.notification.create({
        data: {
            userId: offer.providerId,
            title: "Offer Accepted! 💰",
            body: `Your bid on "${offer.request.title}" has been accepted. Cash on-site arranged.`,
        },
    });
    return booking;
}
// ── Online Queue Entry (ONLY after PayMongo payment succeeds) ─────────────────
async function addToQueue(params) {
    const { serviceId, seekerId, paymentId, offerId } = params;
    const service = await prisma_1.prisma.service.findUnique({
        where: { id: serviceId },
        select: { queueLimit: true, estimatedDurationMins: true, isAvailable: true, title: true, status: true, providerId: true },
    });
    if (!service || service.status !== "ACTIVE") {
        const err = new Error("Service not available");
        err.status = 404;
        throw err;
    }
    // Count current active queue entries
    const currentSize = await prisma_1.prisma.queue.count({
        where: { serviceId, status: { in: ["WAITING", "SERVING"] } },
    });
    if (currentSize >= service.queueLimit) {
        const err = new Error("Queue is full. Please join the waitlist instead.");
        err.status = 409;
        err.code = "QUEUE_FULL";
        throw err;
    }
    const position = await getNextQueuePosition(serviceId);
    const estimatedWait = service.estimatedDurationMins * (position - 1);
    const isImmediate = position === 1; // first in queue = starts now
    // Create Booking row
    const booking = await prisma_1.prisma.booking.create({
        data: {
            seekerId,
            providerId: service.providerId,
            serviceId,
            offerId,
            paymentMethod: "GCash",
            paymentStatus: "PAID_HELD",
            status: isImmediate ? "ONGOING" : "WAITING",
            queuePosition: position,
        },
    });
    // Create Queue entry
    const queueEntry = await prisma_1.prisma.queue.create({
        data: {
            serviceId,
            seekerId,
            offerId,
            paymentId,
            position,
            estimatedWait,
            paymentStatus: "PAID_HELD",
            status: isImmediate ? "SERVING" : "WAITING",
            bookingId: booking.id,
        },
    });
    // Notify provider of new queue entry
    await prisma_1.prisma.notification.create({
        data: {
            userId: service.providerId,
            title: isImmediate ? "New Job Starting Now! 🚀" : "New Queue Entry",
            body: isImmediate
                ? `A new client is at position 1 for "${service.title}". Payment confirmed.`
                : `A new client joined your queue at position ${position} for "${service.title}".`,
        },
    });
    return { queueEntry, isImmediate };
}
// ── Provider Start Job ────────────────────────────────────────────────────────
async function providerStartJob(id, providerId) {
    // Find booking
    let booking = await prisma_1.prisma.booking.findUnique({
        where: { id },
        include: { queue: true }
    });
    let queueEntry = booking?.queue;
    if (!booking) {
        // If not found by booking ID, try by queue ID
        const qe = await prisma_1.prisma.queue.findUnique({
            where: { id },
            include: { booking: true }
        });
        if (qe) {
            booking = qe.booking;
            queueEntry = qe;
        }
    }
    if (!booking || booking.providerId !== providerId) {
        const err = new Error("Booking or queue entry not found or access denied");
        err.status = 404;
        throw err;
    }
    // Update Booking status to ONGOING and started to true
    const updatedBooking = await prisma_1.prisma.booking.update({
        where: { id: booking.id },
        data: {
            status: "ONGOING",
            started: true
        }
    });
    // Update Queue status to SERVING if queue entry exists
    if (queueEntry) {
        await prisma_1.prisma.queue.update({
            where: { id: queueEntry.id },
            data: { status: "SERVING" }
        });
        // Recalculate queue
        await (0, queue_service_1.recalculateQueue)(queueEntry.serviceId);
    }
    // Notify seeker
    await prisma_1.prisma.notification.create({
        data: {
            userId: booking.seekerId,
            title: "Provider Started Job! 🚀",
            body: "Your provider has started serving your request. Coordinates are active.",
        },
    });
    return updatedBooking;
}
// ── Provider Remove Queue Entry ───────────────────────────────────────────────
async function providerRemoveQueueEntry(queueId, providerId) {
    const queueEntry = await prisma_1.prisma.queue.findUnique({
        where: { id: queueId },
        include: { service: true }
    });
    if (!queueEntry || queueEntry.service.providerId !== providerId) {
        const err = new Error("Queue entry not found or access denied");
        err.status = 404;
        throw err;
    }
    // Update Queue status to REMOVED
    await prisma_1.prisma.queue.update({
        where: { id: queueId },
        data: { status: "REMOVED", paymentStatus: "FROZEN_HELD" }
    });
    // Update corresponding Booking status to REMOVED
    if (queueEntry.bookingId) {
        await prisma_1.prisma.booking.update({
            where: { id: queueEntry.bookingId },
            data: { status: "REMOVED", paymentStatus: "FROZEN_HELD" }
        });
    }
    // Deduct provider trust score (-5 for cancellation/removal at fault)
    await (0, trust_service_1.applyCancellationTrust)(providerId, true);
    // Recalculate queue and notify waitlist
    await (0, queue_service_1.recalculateQueue)(queueEntry.serviceId);
    await (0, queue_service_1.notifyWaitlist)(queueEntry.serviceId);
    // Notify seeker
    await prisma_1.prisma.notification.create({
        data: {
            userId: queueEntry.seekerId,
            title: "Booking Cancelled by Provider ⚠️",
            body: "The provider removed your booking from their queue. Refund is being processed.",
        },
    });
    return { success: true };
}
// ── Provider: Mark Job Complete ────────────────────────────────────────────────
async function markJobComplete(id, providerId) {
    // Find booking or queue entry
    let booking = await prisma_1.prisma.booking.findUnique({
        where: { id },
        include: { queue: true }
    });
    let queueEntry = null;
    if (!booking) {
        // Maybe the passed ID is a queue ID
        queueEntry = await prisma_1.prisma.queue.findUnique({
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
    // Transition booking status to AWAITING_CONFIRMATION
    await prisma_1.prisma.booking.update({
        where: { id: booking.id },
        data: { status: "AWAITING_CONFIRMATION" }
    });
    if (queueEntry) {
        await prisma_1.prisma.queue.update({
            where: { id: queueEntry.id },
            data: { status: "DONE" }
        });
        // Recalculate queue & advance next person to SERVING
        await (0, queue_service_1.recalculateQueue)(queueEntry.serviceId);
        const nextEntry = await prisma_1.prisma.queue.findFirst({
            where: { serviceId: queueEntry.serviceId, status: "WAITING" },
            orderBy: { position: "asc" },
        });
        if (nextEntry) {
            await prisma_1.prisma.queue.update({ where: { id: nextEntry.id }, data: { status: "SERVING" } });
            if (nextEntry.bookingId) {
                await prisma_1.prisma.booking.update({
                    where: { id: nextEntry.bookingId },
                    data: { status: "ONGOING" }
                });
            }
        }
    }
    // Notify seeker to confirm
    await prisma_1.prisma.notification.create({
        data: {
            userId: booking.seekerId,
            title: "Service Completed — Please Confirm ✅",
            body: "Your provider has marked the job as done. Go to Activity → Awaiting Confirmation to confirm and release payment.",
        },
    });
    return booking;
}
// ── Seeker: Confirm Completion (release escrow) ───────────────────────────────
async function confirmCompletionService(bookingId, seekerId) {
    const booking = await prisma_1.prisma.booking.findUnique({
        where: { id: bookingId },
        include: { queue: true, directRequest: true, offer: true }
    });
    if (!booking || booking.seekerId !== seekerId) {
        const err = new Error("Booking not found or access denied");
        err.status = 404;
        throw err;
    }
    // Get finalPrice
    let finalPrice = 0;
    if (booking.directRequest) {
        finalPrice = Number(booking.directRequest.agreedPrice);
    }
    else if (booking.offer) {
        finalPrice = Number(booking.offer.offeredPrice);
    }
    else if (booking.serviceId) {
        const service = await prisma_1.prisma.service.findUnique({
            where: { id: booking.serviceId },
            select: { price: true }
        });
        if (service) {
            finalPrice = Number(service.price);
        }
    }
    // Create CompletedService record
    const completedService = await prisma_1.prisma.completedService.create({
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
    await prisma_1.prisma.booking.update({
        where: { id: booking.id },
        data: {
            status: "COMPLETED",
            paymentStatus: "RELEASED"
        }
    });
    // Update Queue status if any
    if (booking.queue) {
        await prisma_1.prisma.queue.update({
            where: { id: booking.queue.id },
            data: {
                status: "DONE",
                paymentStatus: "RELEASED"
            }
        });
    }
    // Release escrow / log earning transaction for provider
    await prisma_1.prisma.transaction.create({
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
    // Update trust score: successful completion gives +2 trust score to provider
    const { applyTrustEvent } = await Promise.resolve().then(() => __importStar(require("./trust.service")));
    await applyTrustEvent(booking.providerId, 2, "Successful service completion");
    // Notify provider
    await prisma_1.prisma.notification.create({
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
async function disputeJobService(bookingId, seekerId, reason) {
    const booking = await prisma_1.prisma.booking.findUnique({
        where: { id: bookingId }
    });
    if (!booking || booking.seekerId !== seekerId) {
        const err = new Error("Booking not found or access denied");
        err.status = 404;
        throw err;
    }
    // Update Booking status to DISPUTED and paymentStatus to FROZEN_HELD
    await prisma_1.prisma.booking.update({
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
    const report = await prisma_1.prisma.report.create({
        data: {
            bookingId: booking.id,
            reporterId: seekerId,
            reportedUserId: booking.providerId,
            reason: reportReason,
            description: `Dispute filed: ${reason}`,
            status: "PENDING"
        }
    });
    // If there's an associated queue entry, freeze its paymentStatus
    if (booking.queuePosition) {
        await prisma_1.prisma.queue.updateMany({
            where: { bookingId: booking.id },
            data: { paymentStatus: "FROZEN_HELD" }
        });
    }
    // Notify provider
    await prisma_1.prisma.notification.create({
        data: {
            userId: booking.providerId,
            title: "Job Disputed ⚠️",
            body: `Seeker has raised a dispute for your booking. Administration will review.`,
        },
    });
    return report;
}
// ── Seeker: Join Waitlist (Notify Me When Open) ───────────────────────────────
async function joinWaitlist(serviceId, seekerId) {
    // Check if already on waitlist
    const existing = await prisma_1.prisma.queueNotify.findUnique({
        where: { serviceId_seekerId: { serviceId, seekerId } },
    });
    if (existing) {
        const err = new Error("You are already on the waitlist for this service");
        err.status = 409;
        throw err;
    }
    return prisma_1.prisma.queueNotify.create({ data: { serviceId, seekerId } });
}
// ── Seeker: Cancel Queue Entry ────────────────────────────────────────────────
async function cancelQueueEntry(queueId, seekerId) {
    const entry = await prisma_1.prisma.queue.findUnique({
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
    if (entry.status === "SERVING") {
        await (0, trust_service_1.applyCancellationTrust)(seekerId, false);
    }
    await prisma_1.prisma.queue.update({ where: { id: queueId }, data: { status: "CANCELLED" } });
    if (entry.bookingId) {
        await prisma_1.prisma.booking.update({
            where: { id: entry.bookingId },
            data: { status: "CANCELED", paymentStatus: "FROZEN_HELD" }
        });
    }
    await (0, queue_service_1.recalculateQueue)(entry.serviceId);
    await (0, queue_service_1.notifyWaitlist)(entry.serviceId);
    // If payment was made, flag for refund review
    if (entry.paymentStatus === "PAID_HELD") {
        await prisma_1.prisma.queue.update({
            where: { id: queueId },
            data: { paymentStatus: "FROZEN_HELD" },
        });
    }
    return { cancelled: true };
}
//# sourceMappingURL=bookings.service.js.map