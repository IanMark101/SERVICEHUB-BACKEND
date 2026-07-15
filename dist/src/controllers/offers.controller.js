import { prisma } from "../lib/prisma";
import { submitOffer, listReceivedOffers, acceptOffer, rejectOffer, } from "../services/offers.service";
export async function create(req, res, next) {
    try {
        const user = req.user;
        const { requestId, offeredPrice, estimatedDuration, availability, message } = req.body;
        if (!requestId || !offeredPrice || !estimatedDuration) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }
        const offer = await submitOffer(user.id, {
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
export async function getReceived(req, res, next) {
    try {
        const user = req.user;
        const offers = await listReceivedOffers(user.id);
        res.json({ success: true, data: offers });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /offers/mine — provider's submitted bids ───────────────────────────────
export async function getMine(req, res, next) {
    try {
        const user = req.user;
        const offers = await prisma.offer.findMany({
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
export async function accept(req, res, next) {
    try {
        const user = req.user;
        const offer = await acceptOffer(req.params.id, user.id);
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
export async function reject(req, res, next) {
    try {
        const user = req.user;
        await rejectOffer(req.params.id, user.id);
        res.json({ success: true, message: "Offer rejected" });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=offers.controller.js.map