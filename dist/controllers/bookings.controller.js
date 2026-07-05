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
exports.bookDirect = bookDirect;
exports.initiatePayment = initiatePayment;
exports.confirmOnlineBooking = confirmOnlineBooking;
exports.joinWaitlistHandler = joinWaitlistHandler;
exports.cancelQueue = cancelQueue;
exports.completeJob = completeJob;
exports.getMyEngagements = getMyEngagements;
exports.respondDirectRequest = respondDirectRequest;
exports.bookDirectFromOffer = bookDirectFromOffer;
exports.startJob = startJob;
exports.providerRemoveFromQueue = providerRemoveFromQueue;
exports.disputeJob = disputeJob;
exports.confirmCompletion = confirmCompletion;
exports.cancelBookingHandler = cancelBookingHandler;
exports.respondCancellationRequestHandler = respondCancellationRequestHandler;
exports.escalateCancellationRequestHandler = escalateCancellationRequestHandler;
exports.adminResolveCancellationRequestHandler = adminResolveCancellationRequestHandler;
const bookings_service_1 = require("../services/bookings.service");
const paymongo_service_1 = require("../services/paymongo.service");
// ── POST /bookings/direct ─────────────────────────────────────────────────────
// Cash / Direct Arrangement — NEVER touches the queue
async function bookDirect(req, res, next) {
    try {
        const user = req.user;
        const { serviceId, agreedPrice, schedule, message } = req.body;
        if (!serviceId || !agreedPrice) {
            return res.status(400).json({ success: false, error: "serviceId and agreedPrice are required" });
        }
        const { prisma } = await Promise.resolve().then(() => __importStar(require("../lib/prisma")));
        const service = await prisma.service.findUnique({
            where: { id: serviceId },
            select: { providerId: true },
        });
        if (!service) {
            return res.status(404).json({ success: false, error: "Service not found" });
        }
        const directRequest = await (0, bookings_service_1.createDirectRequest)({
            seekerId: user.id,
            providerId: service.providerId,
            serviceId,
            agreedPrice: parseFloat(agreedPrice),
            schedule,
            message,
        });
        res.status(201).json({
            success: true,
            message: "Direct Arrangement request sent. Provider will accept or decline.",
            data: directRequest,
        });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /bookings/initiate-payment ──────────────────────────────────────────
async function initiatePayment(req, res, next) {
    try {
        const user = req.user;
        const { serviceId, amount, description, paymentMethodType, returnUrl } = req.body;
        if (!serviceId || !amount) {
            return res.status(400).json({ success: false, error: "serviceId and amount are required" });
        }
        const intent = await (0, paymongo_service_1.createPaymentIntent)({
            amount: parseFloat(amount),
            description: description || "ServiceHub Cordova booking",
        });
        let redirectUrl;
        if (paymentMethodType) {
            // 1. Create Payment Method
            const methodId = await (0, paymongo_service_1.createPaymentMethod)(paymentMethodType);
            // 2. Attach to Intent
            const retUrl = returnUrl || `${process.env.FRONTEND_URL || "http://localhost:3000"}/seeker/seeker-activity`;
            const attachment = await (0, paymongo_service_1.attachPaymentMethod)({
                paymentIntentId: intent.id,
                paymentMethodId: methodId,
                clientKey: intent.clientKey,
                returnUrl: retUrl,
            });
            if (attachment.status === "awaiting_next_action" && attachment.nextAction?.type === "redirect") {
                redirectUrl = attachment.nextAction.redirect.url;
            }
        }
        res.json({
            success: true,
            data: {
                paymentIntentId: intent.id,
                clientKey: intent.clientKey,
                redirectUrl,
            },
        });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /bookings/confirm-online ─────────────────────────────────────────────
async function confirmOnlineBooking(req, res, next) {
    try {
        const user = req.user;
        const { serviceId, paymentIntentId, offerId } = req.body;
        if (!serviceId || !paymentIntentId) {
            return res.status(400).json({ success: false, error: "serviceId and paymentIntentId are required" });
        }
        const paid = await (0, paymongo_service_1.verifyPaymentSuccess)(paymentIntentId);
        if (!paid) {
            return res.status(402).json({
                success: false,
                error: "Payment not confirmed. Please complete payment before booking.",
                code: "PAYMENT_NOT_CONFIRMED",
            });
        }
        const { queueEntry, isImmediate } = await (0, bookings_service_1.addToQueue)({
            serviceId,
            seekerId: user.id,
            paymentId: paymentIntentId,
            offerId,
        });
        res.status(201).json({
            success: true,
            message: isImmediate
                ? "You are next! The provider will start your service now."
                : `You are in the queue at position ${queueEntry.position}. Estimated wait: ${queueEntry.estimatedWait} minutes.`,
            data: queueEntry,
        });
    }
    catch (err) {
        if (err.code === "QUEUE_FULL") {
            return res.status(409).json({
                success: false,
                error: err.message,
                code: "QUEUE_FULL",
                hint: "Use the Notify Me button to join the waitlist.",
            });
        }
        next(err);
    }
}
// ── POST /bookings/waitlist ────────────────────────────────────────────────────
async function joinWaitlistHandler(req, res, next) {
    try {
        const user = req.user;
        const { serviceId } = req.body;
        const entry = await (0, bookings_service_1.joinWaitlist)(serviceId, user.id);
        res.status(201).json({ success: true, data: entry });
    }
    catch (err) {
        next(err);
    }
}
// ── DELETE /bookings/queue/:id ────────────────────────────────────────────────
async function cancelQueue(req, res, next) {
    try {
        const user = req.user;
        const result = await (0, bookings_service_1.cancelQueueEntry)(req.params.id, user.id);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /bookings/queue/:id/complete ────────────────────────────────────────
// Provider marks job done → seeker gets "Awaiting Confirmation" notification
async function completeJob(req, res, next) {
    try {
        const user = req.user;
        const cs = await (0, bookings_service_1.markJobComplete)(req.params.id, user.id);
        res.json({ success: true, data: cs });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /bookings/my-engagements ──────────────────────────────────────────────
async function getMyEngagements(req, res, next) {
    try {
        const user = req.user;
        const { prisma } = await Promise.resolve().then(() => __importStar(require("../lib/prisma")));
        const bookings = await prisma.booking.findMany({
            where: {
                OR: [
                    { seekerId: user.id },
                    { providerId: user.id }
                ]
            },
            include: {
                seeker: {
                    select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true }
                },
                provider: {
                    select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true }
                },
                service: {
                    select: { id: true, title: true, description: true, price: true, priceType: true, estimatedDurationMins: true }
                },
                offer: {
                    include: {
                        request: {
                            select: { title: true }
                        }
                    }
                },
                directRequest: {
                    include: {
                        service: {
                            select: { title: true }
                        }
                    }
                },
                queue: true,
                reports: true,
                cancellationRequests: {
                    orderBy: { createdAt: "desc" }
                },
                messages: {
                    orderBy: { createdAt: "asc" }
                }
            },
            orderBy: { createdAt: "desc" }
        });
        const completedServices = await prisma.completedService.findMany({
            where: {
                OR: [
                    { seekerId: user.id },
                    { providerId: user.id }
                ]
            },
            include: {
                seeker: {
                    select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
                },
                provider: {
                    select: { id: true, name: true, email: true, phone: true, avatarUrl: true, trustScore: true }
                },
                reviews: true,
                booking: {
                    include: {
                        service: { select: { title: true } },
                        offer: { include: { request: { select: { title: true } } } },
                        directRequest: { include: { service: { select: { title: true } } } }
                    }
                }
            },
            orderBy: { completedAt: "desc" }
        });
        res.json({
            success: true,
            data: {
                bookings,
                completedServices
            }
        });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /bookings/direct/:id/respond ────────────────────────────────────────
async function respondDirectRequest(req, res, next) {
    try {
        const user = req.user;
        const { id } = req.params;
        const { accept } = req.body;
        if (typeof accept !== "boolean") {
            return res.status(400).json({ success: false, error: "accept must be a boolean" });
        }
        const { respondToDirectBookingService } = await Promise.resolve().then(() => __importStar(require("../services/bookings.service")));
        const result = await respondToDirectBookingService(id, user.id, accept);
        res.json({
            success: true,
            message: accept ? "Direct arrangement accepted." : "Direct arrangement declined.",
            data: result
        });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /bookings/direct-from-offer ──────────────────────────────────────────
async function bookDirectFromOffer(req, res, next) {
    try {
        const user = req.user;
        const { offerId } = req.body;
        if (!offerId) {
            return res.status(400).json({ success: false, error: "offerId is required" });
        }
        const { createDirectFromOfferService } = await Promise.resolve().then(() => __importStar(require("../services/bookings.service")));
        const booking = await createDirectFromOfferService(offerId, user.id);
        res.status(201).json({
            success: true,
            message: "Bid accepted under Cash Arrangement.",
            data: booking
        });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /bookings/queue/:id/start ───────────────────────────────────────────
async function startJob(req, res, next) {
    try {
        const user = req.user;
        const { id } = req.params;
        const { providerStartJob } = await Promise.resolve().then(() => __importStar(require("../services/bookings.service")));
        const result = await providerStartJob(id, user.id);
        res.json({
            success: true,
            message: "Job started successfully.",
            data: result
        });
    }
    catch (err) {
        next(err);
    }
}
// ── DELETE /bookings/queue/:id/provider ───────────────────────────────────────
async function providerRemoveFromQueue(req, res, next) {
    try {
        const user = req.user;
        const { id } = req.params;
        const { providerRemoveQueueEntry } = await Promise.resolve().then(() => __importStar(require("../services/bookings.service")));
        const result = await providerRemoveQueueEntry(id, user.id);
        res.json({
            success: true,
            message: "Booking removed from queue.",
            data: result
        });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /bookings/:id/dispute ────────────────────────────────────────────────
async function disputeJob(req, res, next) {
    try {
        const user = req.user;
        const { id } = req.params;
        const { reason, description, evidenceUrl } = req.body;
        if (!reason) {
            return res.status(400).json({ success: false, error: "reason is required" });
        }
        const { disputeJobService } = await Promise.resolve().then(() => __importStar(require("../services/bookings.service")));
        const report = await disputeJobService(id, user.id, reason, description, evidenceUrl);
        res.json({
            success: true,
            message: "Dispute report filed successfully.",
            data: report
        });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /bookings/:id/confirm ────────────────────────────────────────────────
async function confirmCompletion(req, res, next) {
    try {
        const user = req.user;
        const { id } = req.params;
        const { confirmCompletionService } = await Promise.resolve().then(() => __importStar(require("../services/bookings.service")));
        const result = await confirmCompletionService(id, user.id);
        res.json({
            success: true,
            message: "Service completion confirmed. Funds released.",
            data: result
        });
    }
    catch (err) {
        next(err);
    }
}
// ── Cancellation Policy Controllers ───────────────────────────────────────────
async function cancelBookingHandler(req, res, next) {
    try {
        const user = req.user;
        const id = req.params.id;
        const { reason } = req.body;
        const { requestCancellation } = await Promise.resolve().then(() => __importStar(require("../services/cancellation.service")));
        const result = await requestCancellation(id, user.id, reason);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function respondCancellationRequestHandler(req, res, next) {
    try {
        const user = req.user;
        const id = req.params.id;
        const { approve, providerNote } = req.body;
        if (typeof approve !== "boolean") {
            return res.status(400).json({ success: false, error: "approve must be a boolean" });
        }
        const { respondToCancellationRequest } = await Promise.resolve().then(() => __importStar(require("../services/cancellation.service")));
        const result = await respondToCancellationRequest(id, user.id, approve, providerNote);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function escalateCancellationRequestHandler(req, res, next) {
    try {
        const user = req.user;
        const id = req.params.id;
        const { escalateCancellationRequest } = await Promise.resolve().then(() => __importStar(require("../services/cancellation.service")));
        const result = await escalateCancellationRequest(id, user.id);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function adminResolveCancellationRequestHandler(req, res, next) {
    try {
        const id = req.params.id;
        const { approve, adminNote } = req.body;
        if (typeof approve !== "boolean") {
            return res.status(400).json({ success: false, error: "approve must be a boolean" });
        }
        const { adminResolveCancellationRequest } = await Promise.resolve().then(() => __importStar(require("../services/cancellation.service")));
        const result = await adminResolveCancellationRequest(id, approve, adminNote);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=bookings.controller.js.map