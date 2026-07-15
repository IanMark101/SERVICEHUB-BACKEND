import { prisma } from "../lib/prisma";
import { assertDistinctAccounts } from "../utils/security";
export async function submitOffer(providerId, params) {
    const { requestId, offeredPrice, estimatedDuration, availability, message } = params;
    // Check request is open
    const request = await prisma.serviceRequest.findUnique({
        where: { id: requestId },
        select: { status: true, seekerId: true },
    });
    if (!request || (request.status !== "OPEN" && request.status !== "IN_PROGRESS")) {
        const err = new Error("Request is not open for offers");
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
            body: `A provider submitted an offer of ₱${offeredPrice} on your request. Check Incoming Offers.`,
            link: `/seeker/incoming-offers?offer=${offer.id}`,
        },
    });
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
            body: `Your offer was accepted. Please proceed to payment to confirm your booking and queue position.`,
            link: `/provider/provider-activity?tab=pending_offers`,
        },
    });
    return updatedOffer;
}
export async function rejectOffer(offerId, seekerId) {
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
    if (offer.request.seekerId !== seekerId) {
        const err = new Error("Not authorized");
        err.status = 403;
        throw err;
    }
    return prisma.offer.update({
        where: { id: offerId },
        data: { status: "REJECTED" },
    });
}
//# sourceMappingURL=offers.service.js.map