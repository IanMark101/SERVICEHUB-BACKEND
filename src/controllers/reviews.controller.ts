import type { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { assertDistinctAccounts } from "../utils/security";
import { safeEmit } from "../lib/socket";
import { ReviewSchema, ReviewUpdateSchema } from "../schema/marketplace.schema";
import { invalidateProviderSummary, summarizeProviderReviews } from "../services/ai.service";
import { applyTrustEventInTransaction, reviewTrustDelta } from "../services/trust.service";

function refreshProviderSummary(providerId: string) {
  invalidateProviderSummary(providerId);
  void summarizeProviderReviews(providerId, undefined, true).catch(() => undefined);
}

export async function submitReview(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const input = ReviewSchema.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const completed = await tx.completedService.findUnique({ where: { id: input.completedServiceId } });
      if (!completed) {
        const error = new Error("Completed service not found") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      const isSeeker = completed.seekerId === user.id;
      const isProvider = completed.providerId === user.id;
      if (!isSeeker && !isProvider) {
        const error = new Error("Not authorized to review this service") as Error & { status?: number };
        error.status = 403;
        throw error;
      }
      const targetId = isSeeker ? completed.providerId : completed.seekerId;
      assertDistinctAccounts(user.id, targetId, "write review");
      const review = await tx.review.create({
        data: {
          completedServiceId: input.completedServiceId,
          authorId: user.id,
          targetId,
          rating: input.rating,
          text: input.text,
          tags: input.tags ?? undefined,
          editableUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      {
        const delta = reviewTrustDelta(input.rating);
        if (delta) {
          await applyTrustEventInTransaction(tx, {
            userId: targetId,
            delta,
            reason: `Received ${input.rating}-star ${isSeeker ? 'provider' : 'seeker'} review`,
            eventKey: `review:${review.id}:rating:v1`,
          });
        }
      }
      await tx.notification.create({
        data: {
          userId: targetId,
          title: "New Review Received",
          body: isSeeker ? `You received a ${input.rating}-star provider review.` : `Your provider left you a ${input.rating}-star seeker review.`,
          link: `${isSeeker ? "/provider" : "/seeker"}/user-profile?id=${targetId}&tab=reviews`,
        },
      });
      return { review, targetId, providerId: isSeeker ? completed.providerId : null };
    });

    safeEmit(`user:${result.targetId}`, "notification", { title: "New Review Received" });
    if (result.providerId) refreshProviderSummary(result.providerId);
    res.status(201).json({ success: true, data: result.review });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return res.status(409).json({ success: false, error: "You have already reviewed this service" });
    }
    next(error);
  }
}

export async function getProviderReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const providerId = req.params.providerId as string;
    const reviews = await prisma.review.findMany({
      where: { targetId: providerId, visibility: "VISIBLE", completedService: { providerId } },
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: reviews });
  } catch (error) {
    next(error);
  }
}

export async function updateReview(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const reviewId = req.params.id as string;
    const input = ReviewUpdateSchema.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`review:${reviewId}`}))`;
      const existing = await tx.review.findUnique({
        where: { id: reviewId },
        include: { completedService: { select: { seekerId: true, providerId: true } } },
      });
      if (!existing) {
        const error = new Error("Review not found") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      if (existing.authorId !== user.id) {
        const error = new Error("You can only edit your own reviews") as Error & { status?: number };
        error.status = 403;
        throw error;
      }
      if (new Date() > existing.editableUntil) {
        const error = new Error("The 24-hour review edit window has expired") as Error & { status?: number };
        error.status = 403;
        throw error;
      }

      const nextRating = input.rating ?? existing.rating;
      const nextVersion = existing.contentVersion + 1;
      const updated = await tx.review.update({
        where: { id: reviewId },
        data: { ...input, contentVersion: { increment: 1 } },
      });
      const eligibleProviderReview = existing.authorId === existing.completedService.seekerId
        && existing.targetId === existing.completedService.providerId
        && existing.visibility === "VISIBLE";
      if (nextRating !== existing.rating) {
        const delta = reviewTrustDelta(nextRating) - reviewTrustDelta(existing.rating);
        if (delta) {
          await applyTrustEventInTransaction(tx, {
            userId: existing.targetId,
            delta,
            reason: `Review rating updated from ${existing.rating} to ${nextRating}`,
            eventKey: `review:${reviewId}:rating:v${nextVersion}`,
          });
        }
      }
      return { updated, providerId: eligibleProviderReview ? existing.completedService.providerId : null };
    });

    if (result.providerId) refreshProviderSummary(result.providerId);
    res.json({ success: true, message: "Review updated successfully", data: result.updated });
  } catch (error) {
    next(error);
  }
}
