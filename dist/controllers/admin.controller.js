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
exports.getOverview = getOverview;
exports.listUsers = listUsers;
exports.updateTrustScore = updateTrustScore;
exports.suspendUser = suspendUser;
exports.banUser = banUser;
exports.restoreUser = restoreUser;
exports.listPendingServices = listPendingServices;
exports.reviewService = reviewService;
exports.listCategorySuggestions = listCategorySuggestions;
exports.resolveCategorySuggestion = resolveCategorySuggestion;
exports.listReports = listReports;
exports.resolveReport = resolveReport;
exports.resolveCancellationRequest = resolveCancellationRequest;
exports.listEscalatedCancellations = listEscalatedCancellations;
const prisma_1 = require("../lib/prisma");
const services_service_1 = require("../services/services.service");
const trust_service_1 = require("../services/trust.service");
const socket_1 = require("../lib/socket");
// ── GET /admin/overview ───────────────────────────────────────────────────────
async function getOverview(_req, res, next) {
    try {
        const [totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions] = await Promise.all([
            prisma_1.prisma.user.count(),
            prisma_1.prisma.service.count({ where: { status: "ACTIVE" } }),
            prisma_1.prisma.serviceVerification.count({ where: { status: "PENDING_REVIEW" } }),
            prisma_1.prisma.report.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
            prisma_1.prisma.service.count({ where: { status: "PENDING_REVIEW" } }),
            prisma_1.prisma.categorySuggested.count({ where: { status: "PENDING" } }),
        ]);
        res.json({
            success: true,
            data: { totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions },
        });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /admin/users ──────────────────────────────────────────────────────────
async function listUsers(req, res, next) {
    try {
        const { search, role, status, page = "1", limit = "10" } = req.query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const skip = (pageNum - 1) * limitNum;
        const where = {};
        if (search) {
            where.OR = [
                { name: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
            ];
        }
        if (role) {
            where.role = role;
        }
        if (status) {
            if (status === "active") {
                where.isActive = true;
            }
            else if (status === "suspended") {
                where.isActive = false;
            }
        }
        const [users, total] = await Promise.all([
            prisma_1.prisma.user.findMany({
                where,
                select: {
                    id: true, name: true, email: true, phone: true, role: true,
                    trustScore: true, verificationStatus: true, emailVerified: true, isActive: true, createdAt: true,
                },
                orderBy: { createdAt: "desc" },
                skip,
                take: limitNum,
            }),
            prisma_1.prisma.user.count({ where }),
        ]);
        res.json({
            success: true,
            data: users,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages: Math.ceil(total / limitNum),
            }
        });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/users/:id/trust ──────────────────────────────────────────────
async function updateTrustScore(req, res, next) {
    try {
        const { delta, reason } = req.body;
        await (0, trust_service_1.applyTrustEvent)(req.params.id, parseInt(delta), reason || "Admin manual override");
        res.json({ success: true });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/users/:id/suspend ────────────────────────────────────────────
async function suspendUser(req, res, next) {
    try {
        await prisma_1.prisma.user.update({ where: { id: req.params.id }, data: { isActive: false } });
        res.json({ success: true, message: "User suspended" });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/users/:id/ban ────────────────────────────────────────────────
async function banUser(req, res, next) {
    try {
        await prisma_1.prisma.user.update({ where: { id: req.params.id }, data: { isActive: false } });
        // Invalidate all sessions
        await prisma_1.prisma.refreshToken.deleteMany({ where: { userId: req.params.id } });
        res.json({ success: true, message: "User banned" });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/users/:id/restore ────────────────────────────────────────────
async function restoreUser(req, res, next) {
    try {
        await prisma_1.prisma.user.update({ where: { id: req.params.id }, data: { isActive: true } });
        res.json({ success: true, message: "User restored" });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /admin/services/pending ───────────────────────────────────────────────
async function listPendingServices(_req, res, next) {
    try {
        const services = await (0, services_service_1.listPendingServices)();
        res.json({ success: true, data: services });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/services/:id/review ──────────────────────────────────────────
async function reviewService(req, res, next) {
    try {
        const { approve, adminNotes } = req.body;
        const result = await (0, services_service_1.adminReviewService)(req.params.id, req.user.id, approve, adminNotes);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /admin/categories/suggestions ─────────────────────────────────────────
async function listCategorySuggestions(_req, res, next) {
    try {
        const suggestions = await prisma_1.prisma.categorySuggested.findMany({
            where: { status: "PENDING" },
            include: { submitter: { select: { id: true, name: true } } },
            orderBy: { submittedAt: "asc" },
        });
        res.json({ success: true, data: suggestions });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/categories/suggestions/:id ────────────────────────────────────
async function resolveCategorySuggestion(req, res, next) {
    try {
        const { approve } = req.body;
        const suggestion = await prisma_1.prisma.categorySuggested.update({
            where: { id: req.params.id },
            data: { status: approve ? "APPROVED" : "REJECTED", reviewedAt: new Date() },
            include: { submitter: { select: { id: true, name: true } } },
        });
        if (approve) {
            // 1. Add to live categories list
            await prisma_1.prisma.category.create({
                data: { name: suggestion.name, isActive: true },
            });
            // 2. Part 18: Auto-post to Community Hub as a system announcement
            // Notify the submitter that their suggestion was approved
            await prisma_1.prisma.notification.create({
                data: {
                    userId: suggestion.submitterId,
                    title: `🎉 Category "${suggestion.name}" Approved!`,
                    body: `Your suggested category "${suggestion.name}" has been added to the ServiceHub Cordova marketplace. Providers can now list services under this category.`,
                },
            });
            (0, socket_1.safeEmit)(`user:${suggestion.submitterId}`, "notification", { title: `🎉 Category "${suggestion.name}" Approved!` });
        }
        else {
            // Notify submitter of rejection
            await prisma_1.prisma.notification.create({
                data: {
                    userId: suggestion.submitterId,
                    title: `Category Suggestion Not Approved`,
                    body: `Your suggested category "${suggestion.name}" was not approved at this time. You may suggest a different category.`,
                },
            });
            (0, socket_1.safeEmit)(`user:${suggestion.submitterId}`, "notification", { title: `Category Suggestion Not Approved` });
        }
        res.json({ success: true, data: suggestion });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /admin/reports ────────────────────────────────────────────────────────
async function listReports(_req, res, next) {
    try {
        const reports = await prisma_1.prisma.report.findMany({
            where: { status: { in: ["PENDING", "UNDER_REVIEW"] } },
            include: {
                reporter: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
                reportedUser: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
                booking: {
                    include: {
                        messages: { orderBy: { createdAt: "asc" }, take: 100 },
                        queue: { select: { paymentStatus: true, joinedAt: true } },
                    },
                },
            },
            orderBy: { createdAt: "asc" },
        });
        res.json({ success: true, data: reports });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/reports/:id/resolve ──────────────────────────────────────────
async function resolveReport(req, res, next) {
    try {
        const { action, adminNotes } = req.body;
        const report = await prisma_1.prisma.report.findUnique({
            where: { id: req.params.id },
            include: { booking: true },
        });
        if (!report)
            return res.status(404).json({ success: false, error: "Report not found" });
        await prisma_1.prisma.report.update({
            where: { id: req.params.id },
            data: {
                status: action === "dismiss" ? "DISMISSED" : "RESOLVED",
                adminId: req.user.id,
                adminNotes,
                resolvedAt: new Date(),
            },
        });
        // Execute the action (Spec Part 8: Warn, Reduce Trust, Suspend, Ban, Dismiss, Approve Refund)
        if (action === "warn") {
            // Just notify — no systemic penalty beyond the notification sent below
            await prisma_1.prisma.notification.create({
                data: {
                    userId: report.reportedUserId,
                    title: "⚠️ Official Warning from Admin",
                    body: `You have received a formal warning regarding a report. ${adminNotes || "Please review your behavior."}`,
                },
            });
            (0, socket_1.safeEmit)(`user:${report.reportedUserId}`, "notification", { title: "⚠️ Official Warning from Admin" });
        }
        else if (action === "trust_deduct") {
            await (0, trust_service_1.applyTrustEvent)(report.reportedUserId, -10, `Admin action on report ${report.id}`);
        }
        else if (action === "suspend") {
            await prisma_1.prisma.user.update({ where: { id: report.reportedUserId }, data: { isActive: false } });
        }
        else if (action === "ban") {
            await prisma_1.prisma.user.update({ where: { id: report.reportedUserId }, data: { isActive: false } });
            // Invalidate all sessions so user is immediately logged out
            await prisma_1.prisma.refreshToken.deleteMany({ where: { userId: report.reportedUserId } });
        }
        else if (action === "approve_refund") {
            await prisma_1.prisma.booking.update({
                where: { id: report.bookingId },
                data: { paymentStatus: "REFUNDED", status: "CANCELED" },
            });
            await prisma_1.prisma.queue.updateMany({
                where: { bookingId: report.bookingId },
                data: { paymentStatus: "REFUNDED" },
            });
        }
        // Notify both parties
        await prisma_1.prisma.notification.createMany({
            data: [
                {
                    userId: report.reporterId,
                    title: "Report Resolved",
                    body: `Your report has been reviewed and resolved. ${adminNotes || ""}`,
                },
                {
                    userId: report.reportedUserId,
                    title: "Report Against You Resolved",
                    body: `A report filed against you has been reviewed. ${adminNotes || ""}`,
                },
            ],
        });
        (0, socket_1.safeEmit)(`user:${report.reporterId}`, "notification", { title: "Report Resolved" });
        (0, socket_1.safeEmit)(`user:${report.reportedUserId}`, "notification", { title: "Report Against You Resolved" });
        res.json({ success: true });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /admin/cancellation-requests/:id/resolve ─────────────────────────────
async function resolveCancellationRequest(req, res, next) {
    try {
        const { approve, adminNote } = req.body;
        if (typeof approve !== "boolean") {
            return res.status(400).json({ success: false, error: "approve must be a boolean" });
        }
        const { adminResolveCancellationRequest } = await Promise.resolve().then(() => __importStar(require("../services/cancellation.service")));
        const result = await adminResolveCancellationRequest(req.params.id, approve, adminNote);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /admin/cancellations/escalated ───────────────────────────────────────
async function listEscalatedCancellations(req, res, next) {
    try {
        const items = await prisma_1.prisma.cancellationRequest.findMany({
            where: { status: "ESCALATED" },
            include: {
                booking: {
                    include: {
                        seeker: { select: { id: true, name: true, email: true, trustScore: true } },
                        provider: { select: { id: true, name: true, email: true, trustScore: true } },
                        service: { select: { title: true } },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, data: items });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=admin.controller.js.map