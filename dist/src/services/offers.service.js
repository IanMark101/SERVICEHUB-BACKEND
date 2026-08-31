import { prisma } from "../lib/prisma";
import { assertDistinctAccounts } from "../utils/security";
import { safeEmit } from "../lib/socket";
export async function submitOffer(providerId, params) {
    const { requestId, offeredPrice, estimatedDuration, availability, message } = params;
    // Check request is open and accepting offers
    const request = await prisma.serviceRequest.findUnique({
        where: { id: requestId },
        select: { status: true, seekerId: true },
    });
    if (!request || request.status !== "OPEN") {
        const err = new Error("This service request is currently paused or closed by the seeker and is no longer accepting new offers.");
        err.status = 400;
        throw err;
    }
    // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
    assertDistinctAccounts(providerId, request.seekerId, "submit offer");
    // Prevent duplicate offer from same provider
    const existing = await prisma.offer.findFirst({
        where: { requestId, providerId, status: "PENDING" },
    });
    if (existing) {
        const err = new Error("You have already submitted an offer for this request");
        err.status = 409;
        throw err;
    }
    const offer = await prisma.offer.create({
        data: {
            requestId,
            providerId,
            offeredPrice,
            estimatedDuration,
            availability,
            message,
            status: "PENDING",
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
        },
    });
    // Notify seeker
    await prisma.notification.create({
        data: {
            userId: request.seekerId,
            title: "New Offer Received",
            body: `A provider submitted an offer of ₱${offeredPrice} on your request. Review it in Service Requests.`,
            link: `/seeker/incoming-offers?offer=${offer.id}`,
        },
    });
    safeEmit(`user:${request.seekerId}`, "notification", { title: "New Offer Received" });
    return offer;
}
export async function listReceivedOffers(seekerId) {
    const myRequests = await prisma.serviceRequest.findMany({
        where: { seekerId },
        select: { id: true },
    });
    const requestIds = myRequests.map((r) => r.id);
    return prisma.offer.findMany({
        where: { requestId: { in: requestIds } },
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
            request: {
                select: {
                    id: true,
                    title: true,
                    status: true,
                },
            },
        },
        orderBy: [{ provider: { trustScore: "desc" } }, { createdAt: "asc" }],
    });
}
export async function acceptOffer(offerId, seekerId) {
    const offer = await prisma.offer.findUnique({
        where: { id: offerId },
        include: {
            request: {
                select: {
                    seekerId: true,
                    status: true,
                    id: true,
                },
            },
        },
    });
    if (!offer) {
        const err = new Error("Offer not found");
        err.status = 404;
        throw err;
    }
    if (offer.request.seekerId !== seekerId) {
        const err = new Error("Not authorized");
        err.status = 403;
        throw err;
    }
    if (offer.request.status !== "OPEN") {
        const err = new Error("Request is no longer open");
        err.status = 400;
        throw err;
    }
    // ── CRITICAL: Self-transaction prohibition (Spec Part 11) — second-layer check ─
    if (seekerId === offer.providerId) {
        const err = new Error("You cannot book or send an offer on your own service listing or request.");
        err.status = 403;
        err.code = "SELF_TRANSACTION_NOT_ALLOWED";
        throw err;
    }
    const updatedOffer = await prisma.$transaction(async (tx) => {
        const accepted = await tx.offer.update({
            where: { id: offerId },
            data: { status: "ACCEPTED" },
        });
        await tx.offer.updateMany({
            where: {
                requestId: offer.requestId,
                id: { not: offerId },
                status: "PENDING",
            },
            data: { status: "REJECTED" },
        });
        await tx.serviceRequest.update({
            where: { id: offer.requestId },
            data: { status: "IN_PROGRESS" },
        });
        return accepted;
    });
    // Notify provider
    await prisma.notification.create({
        data: {
            userId: offer.providerId,
            title: "Offer Accepted! 🎉",
            body: `The seeker accepted your offer of ₱${offer.offeredPrice}! Check your Activity tab.`,
            link: `/provider/provider-activity?tab=all`,
        },
    });
    safeEmit(`user:${offer.providerId}`, "notification", { title: "Offer Accepted! 🎉" });
    return updatedOffer;
}
export async function rejectOffer(offerId, userId) {
    const offer = await prisma.offer.findUnique({
        where: { id: offerId },
        include: {
            request: {
                select: {
                    seekerId: true,
                },
            },
        },
    });
    if (!offer) {
        const err = new Error("Offer not found");
        err.status = 404;
        throw err;
    }
    const isSeeker = offer.request.seekerId === userId;
    const isProvider = offer.providerId === userId;
    if (!isSeeker && !isProvider) {
        const err = new Error("Not authorized");
        err.status = 403;
        throw err;
    }
    const updatedOffer = await prisma.offer.update({
        where: { id: offerId },
        data: { status: "REJECTED" },
    });
    // Real-time socket notification
    safeEmit(`user:${offer.request.seekerId}`, "ENGAGEMENT_CHANGED", { type: "offer_rejected", offerId });
    safeEmit(`user:${offer.providerId}`, "ENGAGEMENT_CHANGED", { type: "offer_rejected", offerId });
    return updatedOffer;
}
//# sourceMappingURL=offers.service.js.map