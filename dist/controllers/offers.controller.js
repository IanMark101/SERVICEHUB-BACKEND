"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = create;
exports.getReceived = getReceived;
exports.getMine = getMine;
exports.accept = accept;
exports.reject = reject;
const prisma_1 = require("../lib/prisma");
const offers_service_1 = require("../services/offers.service");
async function create(req, res, next) {
    try {
        const user = req.user;
        const { requestId, offeredPrice, estimatedDuration, availability, message } = req.body;
        if (!requestId || !offeredPrice || !estimatedDuration) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }
        const offer = await (0, offers_service_1.submitOffer)(user.id, {
            requestId,
            offeredPrice: parseFloat(offeredPrice),
            estimatedDuration: parseInt(estimatedDuration),
            availability,
            message,
        });
        res.status(201).json({ success: true, data: offer });
    }
    catch (err) {
        next(err);
    }
}
async function getReceived(req, res, next) {
    try {
        const user = req.user;
        const offers = await (0, offers_service_1.listReceivedOffers)(user.id);
        res.json({ success: true, data: offers });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /offers/mine — provider's submitted bids ───────────────────────────────
async function getMine(req, res, next) {
    try {
        const user = req.user;
        const offers = await prisma_1.prisma.offer.findMany({
            where: { providerId: user.id },
            include: {
                request: {
                    select: {
                        id: true,
                        title: true,
                        description: true,
                        budgetMin: true,
                        budgetMax: true,
                        urgency: true,
                        status: true,
                        seeker: { select: { id: true, name: true, avatarUrl: true } },
                        category: { select: { id: true, name: true } },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, data: offers });
    }
    catch (err) {
        next(err);
    }
}
async function accept(req, res, next) {
    try {
        const user = req.user;
        const offer = await (0, offers_service_1.acceptOffer)(req.params.id, user.id);
        res.json({
            success: true,
            message: "Offer accepted. Seeker must now complete payment to confirm the queue position.",
            data: offer,
        });
    }
    catch (err) {
        next(err);
    }
}
async function reject(req, res, next) {
    try {
        const user = req.user;
        await (0, offers_service_1.rejectOffer)(req.params.id, user.id);
        res.json({ success: true, message: "Offer rejected" });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=offers.controller.js.map