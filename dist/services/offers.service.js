"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitOffer = submitOffer;
exports.listReceivedOffers = listReceivedOffers;
exports.acceptOffer = acceptOffer;
exports.rejectOffer = rejectOffer;
const prisma_1 = require("../lib/prisma");
async function submitOffer(providerId, params) {
    const { requestId, offeredPrice, estimatedDuration, availability, message } = params;
    // Check request is open
    const request = await prisma_1.prisma.serviceRequest.findUnique({
        where: { id: requestId },
        select: { status: true, seekerId: true },
    });
    if (!request || request.status !== "OPEN") {
        const err = new Error("Request is not open for offers");
        err.status = 400;
        throw err;
    }
    // Prevent duplicate offer from same provider
    const existing = await prisma_1.prisma.offer.findFirst({
        where: { requestId, providerId, status: "PENDING" },
    });
    if (existing) {
        const err = new Error("You have already submitted an offer for this request");
        err.status = 409;
        throw err;
    }
    const offer = await prisma_1.prisma.offer.create({
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
    await prisma_1.prisma.notification.create({
        data: {
            userId: request.seekerId,
            title: "New Offer Received",
            body: `A provider submitted an offer of ₱${offeredPrice} on your request. Check Incoming Offers.`,
        },
    });
    return offer;
}
async function listReceivedOffers(seekerId) {
    const myRequests = await prisma_1.prisma.serviceRequest.findMany({
        where: { seekerId },
        select: { id: true },
    });
    const requestIds = myRequests.map((r) => r.id);
    return prisma_1.prisma.offer.findMany({
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
async function acceptOffer(offerId, seekerId) {
    const offer = await prisma_1.prisma.offer.findUnique({
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
    // Accept this offer
    const updatedOffer = await prisma_1.prisma.offer.update({
        where: { id: offerId },
        data: { status: "ACCEPTED" },
    });
    // Auto-reject all other pending offers on this request (master prompt Section 5)
    await prisma_1.prisma.offer.updateMany({
        where: {
            requestId: offer.requestId,
            id: { not: offerId },
            status: "PENDING",
        },
        data: { status: "REJECTED" },
    });
    // Transition request status to IN_PROGRESS
    await prisma_1.prisma.serviceRequest.update({
        where: { id: offer.requestId },
        data: { status: "IN_PROGRESS" },
    });
    // Notify provider
    await prisma_1.prisma.notification.create({
        data: {
            userId: offer.providerId,
            title: "Offer Accepted! 🎉",
            body: `Your offer was accepted. Please proceed to payment to confirm your booking and queue position.`,
        },
    });
    return updatedOffer;
}
async function rejectOffer(offerId, seekerId) {
    const offer = await prisma_1.prisma.offer.findUnique({
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
    return prisma_1.prisma.offer.update({
        where: { id: offerId },
        data: { status: "REJECTED" },
    });
}
//# sourceMappingURL=offers.service.js.map