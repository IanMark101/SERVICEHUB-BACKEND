"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.browseServices = browseServices;
exports.getServiceById = getServiceById;
exports.createService = createService;
exports.updateService = updateService;
exports.toggleServiceAvailability = toggleServiceAvailability;
exports.deleteService = deleteService;
exports.getMyServices = getMyServices;
exports.listPendingServices = listPendingServices;
exports.adminReviewService = adminReviewService;
const prisma_1 = require("../lib/prisma");
const trust_service_1 = require("./trust.service");
const MAX_ACTIVE_LISTINGS = 3; // free-tier cap (master prompt Section 8)
// ── Browse (Public — ACTIVE listings only) ────────────────────────────────────
async function browseServices(params) {
    const { categoryId, search, availableOnly, excludeProviderId } = params;
    return prisma_1.prisma.service.findMany({
        where: {
            status: "ACTIVE",
            isAvailable: true,
            ...(categoryId && { categoryId }),
            ...(availableOnly && { isAvailable: true }),
            ...(excludeProviderId && { providerId: { not: excludeProviderId } }),
            ...(search && {
                OR: [
                    { title: { contains: search, mode: "insensitive" } },
                    { description: { contains: search, mode: "insensitive" } },
                ],
            }),
        },
        include: {
            provider: {
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
                    verificationStatus: true,
                },
            },
            category: { select: { id: true, name: true } },
            queueEntries: {
                where: { status: { in: ["WAITING", "SERVING"] } },
                select: { id: true, position: true },
            },
        },
        orderBy: [{ provider: { trustScore: "desc" } }, { createdAt: "desc" }],
    });
}
// ── Get Single Service ─────────────────────────────────────────────────────────
async function getServiceById(id) {
    const service = await prisma_1.prisma.service.findUnique({
        where: { id },
        include: {
            provider: {
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
                    verificationStatus: true,
                    bio: true,
                },
            },
            category: true,
            queueEntries: {
                where: { status: { in: ["WAITING", "SERVING"] } },
                orderBy: { position: "asc" },
            },
        },
    });
    if (!service) {
        const err = new Error("Service not found");
        err.status = 404;
        throw err;
    }
    return service;
}
// ── Create Listing (always starts PENDING_REVIEW) ─────────────────────────────
async function createService(providerId, input) {
    // 1. Enforce 3-listing cap for free-tier
    const activeCount = await prisma_1.prisma.service.count({
        where: { providerId, status: { in: ["ACTIVE", "PENDING_REVIEW", "INACTIVE"] } },
    });
    if (activeCount >= MAX_ACTIVE_LISTINGS) {
        const err = new Error(`You can have at most ${MAX_ACTIVE_LISTINGS} active service listings at a time`);
        err.status = 422;
        throw err;
    }
    // 2. Duplicate title check (case-insensitive — DB unique constraint also guards this)
    const duplicate = await prisma_1.prisma.service.findFirst({
        where: {
            providerId,
            title: { equals: input.title, mode: "insensitive" },
            status: { not: "DELETED" },
        },
    });
    if (duplicate) {
        const err = new Error("You already have a listing with this title");
        err.status = 409;
        throw err;
    }
    // 3. Validate category exists and is active
    const category = await prisma_1.prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category || !category.isActive) {
        const err = new Error("Invalid or inactive category");
        err.status = 400;
        throw err;
    }
    return prisma_1.prisma.service.create({
        data: {
            providerId,
            categoryId: input.categoryId,
            title: input.title,
            description: input.description,
            price: input.price,
            priceType: input.priceType,
            estimatedDurationMins: input.estimatedDurationMins,
            queueLimit: input.queueLimit,
            paymentMethods: input.paymentMethods,
            status: "PENDING_REVIEW", // ALWAYS — never goes live without admin approval
            isAvailable: false,
        },
        include: { category: true },
    });
}
// ── Update Listing ─────────────────────────────────────────────────────────────
async function updateService(serviceId, providerId, input) {
    const service = await prisma_1.prisma.service.findFirst({
        where: { id: serviceId, providerId, status: { not: "DELETED" } },
    });
    if (!service) {
        const err = new Error("Service not found or access denied");
        err.status = 404;
        throw err;
    }
    // Changing title or category re-triggers PENDING_REVIEW (master prompt Section 8)
    const titleChanged = input.title && input.title.toLowerCase() !== service.title.toLowerCase();
    const categoryChanged = input.categoryId && input.categoryId !== service.categoryId;
    const requiresReReview = titleChanged || categoryChanged;
    return prisma_1.prisma.service.update({
        where: { id: serviceId },
        data: {
            ...input,
            ...(requiresReReview && { status: "PENDING_REVIEW", isAvailable: false }),
        },
        include: { category: true },
    });
}
// ── Toggle Pause/Active ────────────────────────────────────────────────────────
async function toggleServiceAvailability(serviceId, providerId) {
    const service = await prisma_1.prisma.service.findFirst({
        where: { id: serviceId, providerId, status: "ACTIVE" },
    });
    if (!service) {
        const err = new Error("Service not found, not yours, or not active");
        err.status = 404;
        throw err;
    }
    return prisma_1.prisma.service.update({
        where: { id: serviceId },
        data: { isAvailable: !service.isAvailable },
    });
}
// ── Delete Listing (soft delete) ───────────────────────────────────────────────
async function deleteService(serviceId, providerId) {
    const service = await prisma_1.prisma.service.findFirst({
        where: { id: serviceId, providerId, status: { not: "DELETED" } },
    });
    if (!service) {
        const err = new Error("Service not found or access denied");
        err.status = 404;
        throw err;
    }
    return prisma_1.prisma.service.update({
        where: { id: serviceId },
        data: { status: "DELETED", isAvailable: false },
    });
}
// ── Get My Listings (Provider) ─────────────────────────────────────────────────
async function getMyServices(providerId) {
    return prisma_1.prisma.service.findMany({
        where: { providerId, status: { not: "DELETED" } },
        include: {
            category: { select: { id: true, name: true } },
            queueEntries: {
                where: { status: { in: ["WAITING", "SERVING"] } },
                select: { id: true, position: true },
            },
        },
        orderBy: { createdAt: "desc" },
    });
}
// ── Admin: List Pending Services ───────────────────────────────────────────────
async function listPendingServices() {
    return prisma_1.prisma.service.findMany({
        where: { status: "PENDING_REVIEW" },
        include: {
            provider: {
                select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true },
            },
            category: true,
        },
        orderBy: { createdAt: "asc" },
    });
}
// ── Admin: Approve or Reject Service Listing ──────────────────────────────────
async function adminReviewService(serviceId, adminId, approve, adminNotes) {
    const service = await prisma_1.prisma.service.findUnique({
        where: { id: serviceId },
        include: { provider: true },
    });
    if (!service) {
        const err = new Error("Service not found");
        err.status = 404;
        throw err;
    }
    if (approve) {
        // Check that provider is verified (APPROVED) — unverified providers can draft but not get approved
        if (service.provider.verificationStatus !== "APPROVED") {
            const err = new Error("Provider must be a Verified Resident before their listing can be approved");
            err.status = 422;
            throw err;
        }
        await prisma_1.prisma.service.update({
            where: { id: serviceId },
            data: { status: "ACTIVE", isAvailable: true, adminNotes: adminNotes || null },
        });
        await prisma_1.prisma.notification.create({
            data: {
                userId: service.providerId,
                title: "Listing Approved ✅",
                body: `Your service "${service.title}" is now live and visible to seekers.`,
                link: "/provider/service-manager"
            },
        });
    }
    else {
        // Rejection logic — track count, escalate on repeated rejections
        const newRejectionCount = service.rejectionCount + 1;
        let notifBody = `Your service listing "${service.title}" was not approved. Reason: ${adminNotes || "Please review and resubmit."}`;
        await prisma_1.prisma.service.update({
            where: { id: serviceId },
            data: {
                status: "REJECTED",
                isAvailable: false,
                rejectionCount: newRejectionCount,
                adminNotes: adminNotes || null,
            },
        });
        // 2nd rejection: trust -5
        if (newRejectionCount === 2) {
            await (0, trust_service_1.applyListingRejectionTrust)(service.providerId, 2);
            notifBody += " (Trust score reduced due to repeated rejections.)";
        }
        // 3rd+ rejection: flag account for admin review, suspend posting
        if (newRejectionCount >= 3) {
            await prisma_1.prisma.user.update({
                where: { id: service.providerId },
                data: { isActive: false }, // posting suspended — admin must manually restore
            });
            notifBody += " Your account has been flagged for admin review.";
        }
        await prisma_1.prisma.notification.create({
            data: {
                userId: service.providerId,
                title: "Listing Rejected",
                body: notifBody,
                link: "/provider/service-manager"
            },
        });
    }
    return { approved: approve };
}
//# sourceMappingURL=services.service.js.map