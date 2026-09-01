import { prisma } from "../lib/prisma";
import { applyListingRejectionTrust } from "./trust.service";
import { safeEmit } from "../lib/socket";
const MAX_ACTIVE_LISTINGS = 3; // free-tier cap (master prompt Section 8)
// ── Shared Marketplace Visibility Definition (Canonical Source of Truth) ──────
export const PUBLIC_SERVICE_WHERE = {
    status: "ACTIVE",
    isAvailable: true,
    provider: {
        verificationStatus: "APPROVED",
        isActive: true,
    },
};
export async function getPublicServiceCount() {
    return prisma.service.count({
        where: PUBLIC_SERVICE_WHERE,
    });
}
export async function getActivePublicProviderCount() {
    return prisma.user.count({
        where: {
            verificationStatus: "APPROVED",
            isActive: true,
            services: {
                some: {
                    status: "ACTIVE",
                    isAvailable: true,
                },
            },
        },
    });
}
export async function getRecentlyPublishedServices(limit = 6) {
    return prisma.service.findMany({
        where: PUBLIC_SERVICE_WHERE,
        orderBy: { updatedAt: "desc" }, // actual publication/approval timestamp
        take: limit,
        include: {
            category: { select: { id: true, name: true } },
            provider: {
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
                    verificationStatus: true,
                },
            },
        },
    });
}
// ── Browse (Public — ACTIVE listings only) ────────────────────────────────────
export async function browseServices(params) {
    const { categoryId, search, availableOnly, excludeProviderId } = params;
    return prisma.service.findMany({
        where: {
            ...PUBLIC_SERVICE_WHERE,
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
                    reviewsReceived: { select: { rating: true } },
                },
            },
            category: { select: { id: true, name: true } },
            queueEntries: {
                where: { status: { in: ["WAITING", "SERVING"] } },
                select: { id: true, position: true },
            },
            bookings: {
                where: { status: "ONGOING" },
                select: { id: true },
            },
        },
        orderBy: [{ provider: { trustScore: "desc" } }, { createdAt: "desc" }],
    });
}
// ── Get Single Service ─────────────────────────────────────────────────────────
export async function getServiceById(id) {
    const service = await prisma.service.findFirst({
        // This is a public endpoint. Draft, rejected, paused, and unverified
        // provider listings are available through authenticated owner/admin APIs,
        // never by guessing an ID here.
        where: { id, ...PUBLIC_SERVICE_WHERE },
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
                // Queue records contain seeker and payment data. Public service detail
                // pages need availability only, never identifiers or payment metadata.
                select: { position: true, estimatedWait: true },
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
export async function createService(providerId, input) {
    // 1. Enforce 3-listing cap for free-tier (only count ACTIVE and PENDING_REVIEW)
    const activeCount = await prisma.service.count({
        where: { providerId, status: { in: ["ACTIVE", "PENDING_REVIEW"] } },
    });
    if (activeCount >= MAX_ACTIVE_LISTINGS) {
        const err = new Error(`You can have at most ${MAX_ACTIVE_LISTINGS} active service listings at a time`);
        err.status = 422;
        throw err;
    }
    // 2. Duplicate title check (case-insensitive — DB unique constraint also guards this)
    const duplicate = await prisma.service.findFirst({
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
    const category = await prisma.category.findFirst({
        where: {
            OR: [
                { id: input.categoryId },
                { name: input.categoryId },
            ],
            isActive: true,
        },
    });
    if (!category) {
        const err = new Error("Invalid or inactive category");
        err.status = 400;
        throw err;
    }
    const newService = await prisma.service.create({
        data: {
            providerId,
            categoryId: category.id,
            title: input.title,
            description: input.description,
            price: input.price,
            priceType: input.priceType,
            serviceType: input.serviceType ?? "ONE_TIME",
            estimatedDurationMins: input.estimatedDurationMins,
            queueLimit: input.queueLimit,
            paymentMethods: input.paymentMethods,
            status: "PENDING_REVIEW", // ALWAYS — never goes live without admin approval
            isAvailable: false,
        },
        include: { category: true, provider: { select: { id: true, name: true, email: true } } },
    });
    // 1. Notify Provider in-app that listing is submitted for review
    await prisma.notification.create({
        data: {
            userId: providerId,
            title: "Listing Submitted for Review ⏳",
            body: `Your service listing "${input.title}" was submitted and is pending admin review.`,
            link: "/provider/service-manager?status=pending",
        },
    });
    safeEmit(`user:${providerId}`, "notification", {
        title: "Listing Submitted for Review ⏳",
        body: `Your service listing "${input.title}" is pending admin review.`,
    });
    // 2. Notify all Admins so it appears in their audit queue & bell dropdown
    const admins = await prisma.user.findMany({
        where: { role: "admin" },
        select: { id: true },
    });
    if (admins.length > 0) {
        const adminNotifs = admins.map((admin) => ({
            userId: admin.id,
            title: "📋 New Service Listing Pending Review",
            body: `${newService.provider?.name || "A provider"} submitted a new listing: "${input.title}".`,
            link: "/admin/services",
        }));
        await prisma.notification.createMany({ data: adminNotifs });
        admins.forEach((admin) => {
            safeEmit(`user:${admin.id}`, "notification", {
                title: "📋 New Service Listing Pending Review",
                body: `${newService.provider?.name || "A provider"} submitted a new listing: "${input.title}".`,
                link: "/admin/services",
            });
        });
    }
    // 3. Emit real-time queue update for Admin Services moderation page
    safeEmit("admin", "SERVICE_LISTING_SUBMITTED", { serviceId: newService.id });
    return newService;
}
// ── Update Listing ─────────────────────────────────────────────────────────────
export async function updateService(serviceId, providerId, input) {
    const service = await prisma.service.findFirst({
        where: { id: serviceId, providerId, status: { not: "DELETED" } },
    });
    if (!service) {
        const err = new Error("Service not found or access denied");
        err.status = 404;
        throw err;
    }
    // Changing title or category, OR revising a REJECTED listing re-triggers PENDING_REVIEW
    const titleChanged = input.title && input.title.toLowerCase() !== service.title.toLowerCase();
    const categoryChanged = input.categoryId && input.categoryId !== service.categoryId;
    const wasRejected = service.status === "REJECTED";
    const requiresReReview = titleChanged || categoryChanged || wasRejected;
    return prisma.service.update({
        where: { id: serviceId },
        data: {
            ...input,
            ...(requiresReReview && { status: "PENDING_REVIEW", isAvailable: false }),
        },
        include: { category: true },
    });
}
// ── Toggle Pause/Active ────────────────────────────────────────────────────────
export async function toggleServiceAvailability(serviceId, providerId) {
    const service = await prisma.service.findFirst({
        where: { id: serviceId, providerId, status: "ACTIVE" },
    });
    if (!service) {
        const err = new Error("Service not found, not yours, or not active");
        err.status = 404;
        throw err;
    }
    return prisma.service.update({
        where: { id: serviceId },
        data: { isAvailable: !service.isAvailable },
    });
}
// ── Delete Listing (Hard Erase from DB) ───────────────────────────────────────
export async function deleteService(serviceId, providerId) {
    const service = await prisma.service.findFirst({
        where: { id: serviceId, providerId },
    });
    if (!service) {
        const err = new Error("Service not found or access denied");
        err.status = 404;
        throw err;
    }
    // A listing with active work cannot be erased: deleting its queue rows would
    // orphan a paid booking and leave its payment state unresolved.
    const activeBooking = await prisma.booking.findFirst({
        where: {
            serviceId,
            status: { in: ["PENDING_APPROVAL", "WAITING", "ACCEPTED", "ONGOING", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"] },
        },
        select: { id: true },
    });
    if (activeBooking) {
        const err = new Error("Cannot delete a service with an active booking. Pause the listing and finish or cancel its bookings first.");
        err.status = 409;
        throw err;
    }
    await prisma.queueNotify.deleteMany({ where: { serviceId } });
    return prisma.service.update({
        where: { id: serviceId },
        data: { status: "DELETED", isAvailable: false },
    });
}
// ── Get My Listings (Provider) ─────────────────────────────────────────────────
export async function getMyServices(providerId) {
    return prisma.service.findMany({
        where: { providerId, status: { not: "DELETED" } },
        include: {
            provider: {
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
                    verificationStatus: true,
                    reviewsReceived: { select: { rating: true } },
                },
            },
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
export async function listPendingServices(page = 1, limit = 20) {
    const where = { status: "PENDING_REVIEW" };
    const [items, total] = await Promise.all([
        prisma.service.findMany({
            where,
            include: {
                provider: {
                    select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true },
                },
                category: true,
            },
            orderBy: { createdAt: "asc" },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.service.count({ where }),
    ]);
    return {
        items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
}
// ── Admin: Approve or Reject Service Listing ──────────────────────────────────
export async function adminReviewService(serviceId, adminId, approve, adminNotes) {
    const service = await prisma.service.findUnique({
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
        await prisma.service.update({
            where: { id: serviceId },
            data: { status: "ACTIVE", isAvailable: true, adminNotes: adminNotes || null },
        });
        await prisma.notification.create({
            data: {
                userId: service.providerId,
                title: "Listing Approved ✅",
                body: `Your service "${service.title}" is now live and visible to seekers.`,
                link: `/provider/service-manager?id=${service.id}&status=active`
            },
        });
        safeEmit(`user:${service.providerId}`, "notification", { title: "Listing Approved ✅" });
    }
    else {
        // Rejection logic — track count, escalate on repeated rejections
        const newRejectionCount = service.rejectionCount + 1;
        let notifBody = `Your service listing "${service.title}" was not approved. Reason: ${adminNotes || "Please review and resubmit."}`;
        await prisma.service.update({
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
            await applyListingRejectionTrust(service.providerId, 2);
            notifBody += " (Trust score reduced due to repeated rejections.)";
        }
        // 3rd+ rejection: flag account for admin review, suspend posting
        if (newRejectionCount >= 3) {
            await prisma.user.update({
                where: { id: service.providerId },
                data: { isActive: false }, // posting suspended — admin must manually restore
            });
            notifBody += " Your account has been flagged for admin review.";
        }
        await prisma.notification.create({
            data: {
                userId: service.providerId,
                title: "Listing Rejected",
                body: notifBody,
                link: `/provider/service-manager?id=${service.id}&status=rejected`
            },
        });
        safeEmit(`user:${service.providerId}`, "notification", { title: "Listing Rejected" });
    }
    return { approved: approve };
}
//# sourceMappingURL=services.service.js.map