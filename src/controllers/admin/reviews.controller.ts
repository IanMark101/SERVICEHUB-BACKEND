import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { ReviewModerationSchema } from "../../schema/marketplace.schema";
import { invalidateReviewSummaries } from "../../services/ai.service";
import { safeEmit } from "../../lib/socket";
import { applyReviewContributionInTransaction } from "../../services/trust.service";

export async function listAdminReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const visibility = typeof req.query.visibility === "string" ? req.query.visibility : undefined;
    const where = visibility === "HIDDEN" || visibility === "VISIBLE" ? { visibility: visibility as "HIDDEN" | "VISIBLE" } : {};
    const [items, total] = await Promise.all([
      prisma.review.findMany({
        where,
        include: { author: { select: { id: true, name: true } }, target: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.review.count({ where }),
    ]);
    res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}

export async function moderateReview(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = (req as AuthenticatedRequest).user.id;
    const { action, reason } = ReviewModerationSchema.parse(req.body);
    const visibility = action === "hide" ? "HIDDEN" : "VISIBLE";
    const review = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`review:${req.params.id as string}`}))`;
      const current = await tx.review.findUnique({
        where: { id: req.params.id as string },
        include: { completedService: { select: { seekerId: true, providerId: true } } },
      });
      if (!current) {
        const error = new Error("Review not found") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      if (current.visibility === visibility) {
        const error = new Error(`Review is already ${visibility.toLowerCase()}`) as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      const updated = await tx.review.update({
        where: { id: current.id },
        data: { visibility, moderationReason: reason, moderatedById: adminId, moderatedAt: new Date(), contentVersion: { increment: 1 } },
      });
      await applyReviewContributionInTransaction(tx, { userId: current.targetId, reviewId: current.id, rating: current.rating,
        visible: action === "restore", reason: `Review ${action === "hide" ? "hidden" : "restored"} by administrator`,
        actorAdminId: adminId, eventKey: `review:${current.id}:moderation:v${updated.contentVersion}` });
      const eligibleProviderReview = current.authorId === current.completedService.seekerId
        && current.targetId === current.completedService.providerId;
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: current.authorId, action: action === "hide" ? "REVIEW_HIDDEN" : "REVIEW_RESTORED", resourceType: "Review", resourceId: current.id, reason, metadata: { targetId: current.targetId } },
      });
      await tx.notification.createMany({ data: [
        { userId: current.authorId, title: action === "hide" ? "Review hidden" : "Review restored", body: `An administrator ${action === "hide" ? "hid" : "restored"} your review. Reason: ${reason}` },
        { userId: current.targetId, title: action === "hide" ? "Review hidden" : "Review restored", body: `An administrator ${action === "hide" ? "hid" : "restored"} a review on your profile.` },
      ] });
      return { updated, providerId: eligibleProviderReview ? current.completedService.providerId : null, authorId: current.authorId, targetId: current.targetId };
    });
    invalidateReviewSummaries(review.targetId);
    safeEmit(`user:${review.authorId}`, "notification", { title: action === "hide" ? "Review hidden" : "Review restored" });
    safeEmit(`user:${review.targetId}`, "notification", { title: action === "hide" ? "Review hidden" : "Review restored" });
    safeEmit(`user:${review.targetId}`, "accountStatusChanged", { trustChanged: true });
    res.json({ success: true, data: review.updated });
  } catch (error) {
    next(error);
  }
}
