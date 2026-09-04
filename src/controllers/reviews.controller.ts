import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { applyReviewTrust } from "../services/trust.service";
import { assertDistinctAccounts } from "../utils/security";
import { safeEmit } from "../lib/socket";
import { ReviewSchema, ReviewUpdateSchema } from "../schema/marketplace.schema";
import { invalidateProviderSummary, summarizeProviderReviews } from "../services/ai.service";

function refreshProviderSummary(providerId: string) {
  invalidateProviderSummary(providerId);
  void summarizeProviderReviews(providerId).catch((error) => {
    console.warn("[AI Service] Could not pre-warm provider summary", error);
  });
}

export async function submitReview(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { completedServiceId, rating, text, tags } = ReviewSchema.parse(req.body);

    const completedService = await prisma.completedService.findUnique({
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

    assertDistinctAccounts(user.id, targetId, "write review");

    // Check for duplicate review
    const existing = await prisma.review.findFirst({
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

    const review = await prisma.review.create({
      data: {
        completedServiceId,
        authorId: user.id,
        targetId,
        rating,
        text,
        tags: tags ? tags : undefined,
        editableUntil
      }
    });

    // Update target trust score
    await applyReviewTrust(targetId, rating);

    // Create notification and socket alert for the reviewed party
    if (isSeeker) {
      await prisma.notification.create({
        data: {
          userId: targetId,
          title: "New Review Received ⭐",
          body: `You received a ${rating}-star review. Check your profile.`,
          link: `/provider/user-profile?id=${targetId}&tab=reviews`
        }
      });
      safeEmit(`user:${targetId}`, "notification", { title: "New Review Received ⭐" });
    } else if (isProvider) {
      await prisma.notification.create({
        data: {
          userId: targetId,
          title: "New Review Received ⭐",
          body: `Your provider left you a ${rating}-star review. Check your profile.`,
          link: `/seeker/user-profile?id=${targetId}&tab=reviews`
        }
      });
      safeEmit(`user:${targetId}`, "notification", { title: "New Review Received ⭐" });
    }

    res.status(201).json({
      success: true,
      data: review
    });
    refreshProviderSummary(targetId);
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

export async function getProviderReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId } = req.params;

    const reviews = await prisma.review.findMany({
      where: {
        targetId: providerId as string
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
  } catch (err) {
    next(err);
  }
}

export async function updateReview(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const reviewId = req.params.id as string;
    const { rating, text, tags } = ReviewUpdateSchema.parse(req.body);

    const existing = await prisma.review.findUnique({
      where: { id: reviewId }
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "Review not found" });
    }

    if (existing.authorId !== user.id) {
      return res.status(403).json({ success: false, error: "You can only edit your own reviews" });
    }

    // Part 14: Check 24-hour grace window
    if (new Date() > new Date(existing.editableUntil)) {
      return res.status(403).json({
        success: false,
        error: "The 24-hour edit grace window has expired. Reviews cannot be edited after 24 hours."
      });
    }

    const oldRating = existing.rating;
    const newRating = rating !== undefined ? rating : oldRating;

    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: {
        ...(rating !== undefined && { rating: newRating }),
        ...(text !== undefined && { text }),
        ...(tags !== undefined && { tags }),
      }
    });

    // If rating changed, adjust trust score delta accordingly
    if (rating !== undefined && newRating !== oldRating) {
      const getDelta = (r: number) => (r === 5 ? 2 : r === 4 ? 1 : r === 2 ? -3 : r === 1 ? -5 : 0);
      const diff = getDelta(newRating) - getDelta(oldRating);
      if (diff !== 0) {
        const { applyTrustEvent } = await import("../services/trust.service");
        await applyTrustEvent(
          existing.targetId,
          diff,
          `Review rating updated (${oldRating}★ to ${newRating}★)`
        );
      }
    }

    res.json({
      success: true,
      message: "Review updated successfully",
      data: updated
    });
    refreshProviderSummary(existing.targetId);
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

