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
const socket_1 = require("../lib/socket");
const security_1 = require("../utils/security");
const messages_service_1 = require("./messages.service");
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
async function resolveFinalPrice(booking) {
    if (booking.directRequest)
        return Number(booking.directRequest.agreedPrice);
    if (booking.offer)
        return Number(booking.offer.offeredPrice);
    if (booking.service)
        return Number(booking.service.price);
    if (booking.serviceId) {
        const service = await prisma_1.prisma.service.findUnique({
            where: { id: booking.serviceId },
            select: { price: true },
        });
        return service ? Number(service.price) : 0;
    }
    return 0;
}
// ── Cash Direct Request (no queue) ────────────────────────────────────────────
async function createDirectRequest(params) {
    const { seekerId, providerId, serviceId, agreedPrice, schedule, message } = params;
    // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
    (0, security_1.assertDistinctAccounts)(seekerId, providerId, "book service");
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
    const { directRequest, booking } = await prisma_1.prisma.$transaction(async (tx) => {
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
    await prisma_1.prisma.notification.create({
        data: {
            userId: providerId,
            title: "New Direct Booking Request",
            body: `A new Direct Arrangement booking request has arrived for "${service.title}". Review it in Incoming Requests.`,
            link: `/provider/provider-activity?tab=waiting&booking=${booking.id}`,
        },
    });
    (0, socket_1.safeEmit)(`user:${providerId}`, "notification", { title: "New Direct Booking Request" });
    return { ...directRequest, booking };
}
// ── Respond to Direct Booking (Accept / Decline) ──────────────────────────────
async function respondToDirectBookingService(requestId, providerId, accept) {
    // Check if requestId is a directRequest ID or a booking ID
    let directRequest = await prisma_1.prisma.directRequest.findUnique({
        where: { id: requestId },
        include: { booking: true },
    });
    if (!directRequest) {
        const booking = await prisma_1.prisma.booking.findUnique({
            where: { id: requestId },
            include: { directRequest: true },
        });
        if (booking?.directRequest) {
            directRequest = {
                ...booking.directRequest,
                booking: booking
            };
        }
    }
    if (!directRequest || directRequest.providerId !== providerId) {
        const err = new Error("Direct request not found or access denied");
        err.status = 404;
        throw err;
    }
    const existingBooking = directRequest.booking;
    if (accept) {
        const booking = await prisma_1.prisma.$transaction(async (tx) => {
            await tx.directRequest.update({
                where: { id: directRequest.id },
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
        await prisma_1.prisma.notification.create({
            data: {
                userId: directRequest.seekerId,
                title: "Direct Booking Accepted! 🎉",
                body: "Your direct booking request has been accepted. Coordinate with the provider via chat.",
                link: `/seeker/seeker-activity?tab=active&booking=${booking.id}`,
            },
        });
        (0, socket_1.safeEmit)(`user:${directRequest.seekerId}`, "notification", { title: "Direct Booking Accepted! 🎉" });
        await (0, messages_service_1.sendMessage)(booking.id, providerId, "Booking accepted.", undefined, true);
        return booking;
    }
    else {
        const updatedRequest = await prisma_1.prisma.$transaction(async (tx) => {
            if (existingBooking) {
                await tx.booking.update({
                    where: { id: existingBooking.id },
                    data: { status: "DECLINED" },
                });
            }
            return tx.directRequest.update({
                where: { id: directRequest.id },
                data: { status: "DECLINED" },
            });
        });
        await prisma_1.prisma.notification.create({
            data: {
                userId: directRequest.seekerId,
                title: "Direct Booking Declined ❌",
                body: "Your direct booking request was declined by the provider.",
                link: `/seeker/seeker-activity?tab=canceled&booking=${directRequest.id}`,
            },
        });
        (0, socket_1.safeEmit)(`user:${directRequest.seekerId}`, "notification", { title: "Direct Booking Declined ❌" });
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
    // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
    (0, security_1.assertDistinctAccounts)(seekerId, offer.providerId, "accept offer");
    const booking = await prisma_1.prisma.$transaction(async (tx) => {
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
    await prisma_1.prisma.notification.create({
        data: {
            userId: offer.providerId,
            title: "Offer Accepted! 💰",
            body: `Your offer on "${offer.request.title}" has been accepted. Cash on-site arranged.`,
            link: `/provider/provider-activity?tab=in_progress&booking=${booking.id}`,
        },
    });
    await (0, messages_service_1.sendMessage)(booking.id, seekerId, "Booking accepted.", undefined, true);
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
    // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
    if (seekerId === service.providerId) {
        const err = new Error("You cannot book or send an offer on your own service listing or request.");
        err.status = 403;
        err.code = "SELF_TRANSACTION_NOT_ALLOWED";
        throw err;
    }
    if (offerId) {
        const offer = await prisma_1.prisma.offer.findUnique({
            where: { id: offerId },
            include: { request: true },
        });
        if (!offer || offer.status !== "ACCEPTED" || offer.request.seekerId !== seekerId || offer.providerId !== service.providerId) {
            const err = new Error("Accepted offer does not match this online booking");
            err.status = 400;
            throw err;
        }
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
    const isImmediate = position === 1; // provider is free, so no Queue row is created
    // Create Booking row
    // When isImmediate (position 1, provider is free), the spec says service starts
    // immediately — so both status and started flag must reflect this.
    const booking = await prisma_1.prisma.booking.create({
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
    await (0, messages_service_1.sendMessage)(booking.id, seekerId, "Payment received.", undefined, true);
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
        : await prisma_1.prisma.queue.create({
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
    await prisma_1.prisma.notification.create({
        data: {
            userId: service.providerId,
            title: isImmediate ? "New Job Starting Now! 🚀" : "New Queue Entry",
            body: isImmediate
                ? `A new client is at position 1 for "${service.title}". Payment confirmed.`
                : `A new client joined your queue at position ${position} for "${service.title}".`,
            link: `/provider/provider-activity?tab=${isImmediate ? 'in_progress' : 'waiting'}&booking=${booking.id}`,
        },
    });
    // ── Real-time: notify all clients watching this service's queue ───────────
    (0, socket_1.safeEmit)(`service:${serviceId}`, "queue_update", {
        serviceId,
        delta: isImmediate ? 0 : +1,
        currentSize: isImmediate ? currentSize : currentSize + 1,
    });
    // Notify the provider in their personal room
    (0, socket_1.safeEmit)(`user:${service.providerId}`, "notification", { title: isImmediate ? "New Job Starting Now! 🚀" : "New Queue Entry" });
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
    // Starting a queued job removes it from Queue; active work is tracked by Booking.
    if (queueEntry) {
        await prisma_1.prisma.queue.delete({
            where: { id: queueEntry.id },
        });
        await (0, queue_service_1.recalculateQueue)(queueEntry.serviceId);
        await (0, queue_service_1.notifyWaitlist)(queueEntry.serviceId);
    }
    // Notify seeker
    await prisma_1.prisma.notification.create({
        data: {
            userId: booking.seekerId,
            title: "Provider Started Job! 🚀",
            body: "Your provider has started serving your request. Coordinates are active.",
            link: `/seeker/seeker-activity?tab=active&booking=${booking.id}`,
        },
    });
    (0, socket_1.safeEmit)(`user:${booking.seekerId}`, "notification", { title: "Provider Started Job! 🚀" });
    await (0, messages_service_1.sendMessage)(booking.id, booking.providerId, "Provider started the job.", undefined, true);
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
        await (0, messages_service_1.sendMessage)(queueEntry.bookingId, providerId, "Booking cancelled.", undefined, true);
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
            link: `/seeker/seeker-activity?tab=canceled&booking=${queueEntry.bookingId}`,
        },
    });
    // ── Real-time queue update ────────────────────────────────────────────────
    (0, socket_1.safeEmit)(`service:${queueEntry.serviceId}`, "queue_update", { serviceId: queueEntry.serviceId, delta: -1 });
    (0, socket_1.safeEmit)(`user:${queueEntry.seekerId}`, "notification", { title: "Booking Cancelled by Provider ⚠️" });
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
    if (booking.status !== "ONGOING") {
        const err = new Error("Only ongoing jobs can be marked completed");
        err.status = 400;
        throw err;
    }
    // Transition booking status to AWAITING_CONFIRMATION
    await prisma_1.prisma.booking.update({
        where: { id: booking.id },
        data: { status: "AWAITING_CONFIRMATION" }
    });
    // Notify seeker to confirm
    await prisma_1.prisma.notification.create({
        data: {
            userId: booking.seekerId,
            title: "Service Completed — Please Confirm ✅",
            body: "Your provider has marked the job as done. Go to Activity → Awaiting Confirmation to confirm and release payment.",
            link: `/seeker/seeker-activity?tab=action_required&booking=${booking.id}`,
        },
    });
    // ── Real-time: notify seeker to confirm ──────────────────────────────────
    (0, socket_1.safeEmit)(`user:${booking.seekerId}`, "notification", { title: "Service Completed — Please Confirm ✅" });
    if (queueEntry)
        (0, socket_1.safeEmit)(`service:${queueEntry.serviceId}`, "queue_update", { serviceId: queueEntry.serviceId, delta: 0 });
    return booking;
}
// ── Seeker: Confirm Completion (release escrow) ───────────────────────────────
async function confirmCompletionService(bookingId, seekerId) {
    const booking = await prisma_1.prisma.booking.findUnique({
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
    if (booking.paymentMethod === 'GCash') {
        await (0, messages_service_1.sendMessage)(booking.id, seekerId, "Funds released.", undefined, true);
    }
    else {
        await (0, messages_service_1.sendMessage)(booking.id, seekerId, "Transaction completed.", undefined, true);
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
    // Update trust score: successful completion gives +2 trust to provider and +1 to seeker (if distinct)
    if (booking.providerId !== booking.seekerId) {
        const { applyTrustEvent } = await Promise.resolve().then(() => __importStar(require("./trust.service")));
        await applyTrustEvent(booking.providerId, 2, "Successful service completion (provider)");
        await applyTrustEvent(booking.seekerId, 1, "Successful service completion (seeker)");
    }
    // Notify provider
    await prisma_1.prisma.notification.create({
        data: {
            userId: booking.providerId,
            title: "Payment Confirmed 💰",
            body: booking.paymentMethod === "GCash"
                ? `₱${finalPrice} has been released to your wallet.`
                : `Seeker confirmed completion of cash-based job for ₱${finalPrice}.`,
            link: `/provider/transaction-history?booking=${booking.id}`,
        },
    });
    (0, socket_1.safeEmit)(`user:${booking.providerId}`, "notification", { title: "Payment Confirmed 💰" });
    return completedService;
}
// ── Seeker: Dispute Job ───────────────────────────────────────────────────────
async function disputeJobService(bookingId, seekerId, reason, description, evidenceUrl) {
    const booking = await prisma_1.prisma.booking.findUnique({
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
    (0, security_1.assertDistinctAccounts)(seekerId, booking.providerId, "dispute job");
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
            description: description || `Dispute filed: ${reason}`,
            evidenceUrl: evidenceUrl || null,
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
            link: `/provider/provider-activity?tab=disputed&booking=${booking.id}`,
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
    await prisma_1.prisma.queue.update({
        where: { id: queueId },
        data: { status: "CANCELLED", paymentStatus: entry.paymentStatus === "PAID_HELD" ? "REFUNDED" : entry.paymentStatus }
    });
    if (entry.bookingId) {
        await prisma_1.prisma.booking.update({
            where: { id: entry.bookingId },
            data: { status: "CANCELED", paymentStatus: entry.paymentStatus === "PAID_HELD" ? "REFUNDED" : "UNPAID" }
        });
        await (0, messages_service_1.sendMessage)(entry.bookingId, seekerId, "Booking cancelled.", undefined, true);
    }
    // If an online payment was refunded, create a REFUND transaction record (Spec Part 5)
    if (entry.paymentStatus === "PAID_HELD") {
        const booking = await prisma_1.prisma.booking.findUnique({
            where: { id: entry.bookingId || undefined },
            include: { service: true, offer: true, directRequest: true }
        });
        let refundAmount = 0;
        if (booking) {
            if (booking.directRequest) {
                refundAmount = Number(booking.directRequest.agreedPrice);
            }
            else if (booking.offer) {
                refundAmount = Number(booking.offer.offeredPrice);
            }
            else if (booking.service) {
                refundAmount = Number(booking.service.price);
            }
        }
        if (refundAmount > 0) {
            await prisma_1.prisma.transaction.create({
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
    await (0, queue_service_1.recalculateQueue)(entry.serviceId);
    await (0, queue_service_1.notifyWaitlist)(entry.serviceId);
    // ── Real-time queue update ────────────────────────────────────────────────
    (0, socket_1.safeEmit)(`service:${entry.serviceId}`, "queue_update", { serviceId: entry.serviceId, delta: -1 });
    return { cancelled: true };
}
//# sourceMappingURL=bookings.service.js.map