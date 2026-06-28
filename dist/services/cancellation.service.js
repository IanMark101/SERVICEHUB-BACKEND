"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.performImmediateCancel = performImmediateCancel;
exports.requestCancellation = requestCancellation;
exports.respondToCancellationRequest = respondToCancellationRequest;
exports.escalateCancellationRequest = escalateCancellationRequest;
exports.adminResolveCancellationRequest = adminResolveCancellationRequest;
const prisma_1 = require("../lib/prisma");
const queue_service_1 = require("./queue.service");
// ── Perform Immediate Cancel & Process Refund/Escrow ──────────────────────────
async function performImmediateCancel(bookingId) {
    const booking = await prisma_1.prisma.booking.findUnique({
        where: { id: bookingId },
        include: { queue: true }
    });
    if (!booking)
        return;
    // Update Booking status to CANCELED
    await prisma_1.prisma.booking.update({
        where: { id: bookingId },
        data: {
            status: "CANCELED",
            paymentStatus: booking.paymentStatus === "PAID_HELD" ? "FROZEN_HELD" : booking.paymentStatus
        }
    });
    if (booking.queue) {
        await prisma_1.prisma.queue.update({
            where: { id: booking.queue.id },
            data: {
                status: "CANCELLED",
                paymentStatus: booking.queue.paymentStatus === "PAID_HELD" ? "FROZEN_HELD" : booking.queue.paymentStatus
            }
        });
        // Recalculate queue and notify waitlist
        await (0, queue_service_1.recalculateQueue)(booking.queue.serviceId);
        await (0, queue_service_1.notifyWaitlist)(booking.queue.serviceId);
    }
    // Notify provider
    await prisma_1.prisma.notification.create({
        data: {
            userId: booking.providerId,
            title: "Booking Cancelled ⚠️",
            body: "The booking has been cancelled.",
        }
    });
}
// ── Request Cancellation ───────────────────────────────────────────────────────
async function requestCancellation(bookingId, seekerId, reason) {
    const booking = await prisma_1.prisma.booking.findUnique({
        where: { id: bookingId }
    });
    if (!booking || booking.seekerId !== seekerId) {
        const err = new Error("Booking not found or access denied");
        err.status = 404;
        throw err;
    }
    if (booking.started === false) {
        // Seeker can cancel anytime instantly
        await performImmediateCancel(bookingId);
        return { cancelled: true, immediate: true };
    }
    else {
        // started === true -> create CancellationRequest with status: PENDING
        const existing = await prisma_1.prisma.cancellationRequest.findFirst({
            where: { bookingId, status: "PENDING" }
        });
        if (existing) {
            const err = new Error("A cancellation request is already pending for this booking");
            err.status = 409;
            throw err;
        }
        const cancelReq = await prisma_1.prisma.cancellationRequest.create({
            data: {
                bookingId,
                requestedBy: seekerId,
                reason,
                status: "PENDING"
            }
        });
        // Notify provider
        await prisma_1.prisma.notification.create({
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
async function respondToCancellationRequest(requestId, providerId, approve, providerNote) {
    const cancelReq = await prisma_1.prisma.cancellationRequest.findUnique({
        where: { id: requestId },
        include: { booking: true }
    });
    if (!cancelReq || cancelReq.booking.providerId !== providerId) {
        const err = new Error("Cancellation request not found or access denied");
        err.status = 404;
        throw err;
    }
    if (cancelReq.status !== "PENDING") {
        const err = new Error("Cancellation request has already been resolved");
        err.status = 400;
        throw err;
    }
    if (approve) {
        await prisma_1.prisma.cancellationRequest.update({
            where: { id: requestId },
            data: {
                status: "APPROVED",
                resolvedAt: new Date()
            }
        });
        await performImmediateCancel(cancelReq.bookingId);
        // Notify seeker
        await prisma_1.prisma.notification.create({
            data: {
                userId: cancelReq.booking.seekerId,
                title: "Cancellation Request Approved 🎉",
                body: "The provider has approved your cancellation request. Payout is refunded/cancelled.",
            }
        });
        return { resolved: true, approved: true };
    }
    else {
        const updated = await prisma_1.prisma.cancellationRequest.update({
            where: { id: requestId },
            data: {
                status: "DECLINED",
                providerNote,
                resolvedAt: new Date()
            }
        });
        // Notify seeker
        await prisma_1.prisma.notification.create({
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
async function escalateCancellationRequest(requestId, seekerId) {
    const cancelReq = await prisma_1.prisma.cancellationRequest.findUnique({
        where: { id: requestId },
        include: { booking: true }
    });
    if (!cancelReq || cancelReq.booking.seekerId !== seekerId) {
        const err = new Error("Cancellation request not found or access denied");
        err.status = 404;
        throw err;
    }
    if (cancelReq.status !== "DECLINED") {
        const err = new Error("Only declined cancellation requests can be escalated");
        err.status = 400;
        throw err;
    }
    const updated = await prisma_1.prisma.cancellationRequest.update({
        where: { id: requestId },
        data: { status: "ESCALATED" }
    });
    // Create standard dispute Report case
    await prisma_1.prisma.report.create({
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
    await prisma_1.prisma.notification.create({
        data: {
            userId: cancelReq.booking.providerId,
            title: "Cancellation Escalated to Admin ⚠️",
            body: "The seeker has escalated their declined cancellation request to a Moderator/Admin.",
        }
    });
    return updated;
}
// ── Resolve Cancellation Request (Admin/Moderator Action) ─────────────────────
async function adminResolveCancellationRequest(requestId, approve, adminNote) {
    const cancelReq = await prisma_1.prisma.cancellationRequest.findUnique({
        where: { id: requestId },
        include: { booking: true }
    });
    if (!cancelReq) {
        const err = new Error("Cancellation request not found");
        err.status = 404;
        throw err;
    }
    if (cancelReq.status !== "ESCALATED") {
        const err = new Error("Only escalated cancellation requests can be resolved by admin");
        err.status = 400;
        throw err;
    }
    // Update request status to RESOLVED
    const updatedRequest = await prisma_1.prisma.cancellationRequest.update({
        where: { id: requestId },
        data: {
            status: "RESOLVED",
            adminNote,
            resolvedAt: new Date()
        }
    });
    // Update associated Reports to RESOLVED
    await prisma_1.prisma.report.updateMany({
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
        await prisma_1.prisma.notification.createMany({
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
    }
    else {
        // Reject cancellation request -> booking stays as-is (ONGOING)
        await prisma_1.prisma.notification.createMany({
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
//# sourceMappingURL=cancellation.service.js.map