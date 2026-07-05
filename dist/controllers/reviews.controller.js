"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitReview = submitReview;
exports.getProviderReviews = getProviderReviews;
const prisma_1 = require("../lib/prisma");
const trust_service_1 = require("../services/trust.service");
async function submitReview(req, res, next) {
    try {
        const user = req.user;
        const { completedServiceId, rating, text, tags } = req.body;
        if (!completedServiceId || !rating) {
            return res.status(400).json({ success: false, error: "completedServiceId and rating are required" });
        }
        const completedService = await prisma_1.prisma.completedService.findUnique({
            where: { id: completedServiceId }
        });
        if (!completedService) {
            return res.status(404).json({ success: false, error: "Completed service not found" });
        }
        // Verify user is either seeker or provider
        const isSeeker = completedService.seekerId === user.id;
        const isProvider = completedService.providerId === user.id;
        if (!isSeeker && !isProvider) {
            return res.status(403).json({ success: false, error: "Not authorized to review this service" });
        }
        const targetId = isSeeker ? completedService.providerId : completedService.seekerId;
        // Check for duplicate review
        const existing = await prisma_1.prisma.review.findFirst({
            where: {
                completedServiceId,
                authorId: user.id
            }
        });
        if (existing) {
            return res.status(409).json({ success: false, error: "You have already reviewed this service" });
        }
        // 24 hour edit window
        const editableUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const review = await prisma_1.prisma.review.create({
            data: {
                completedServiceId,
                authorId: user.id,
                targetId,
                rating: parseInt(rating),
                text,
                tags: tags ? tags : undefined,
                editableUntil
            }
        });
        // Update target trust score
        await (0, trust_service_1.applyReviewTrust)(targetId, parseInt(rating));
        res.status(201).json({
            success: true,
            data: review
        });
    }
    catch (err) {
        next(err);
    }
}
async function getProviderReviews(req, res, next) {
    try {
        const { providerId } = req.params;
        const reviews = await prisma_1.prisma.review.findMany({
            where: {
                targetId: providerId
            },
            include: {
                author: {
                    select: {
                        id: true,
                        name: true,
                        avatarUrl: true
                    }
                }
            },
            orderBy: {
                createdAt: "desc"
            }
        });
        res.json({
            success: true,
            data: reviews
        });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=reviews.controller.js.map