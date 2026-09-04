import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { listPendingServices as adminListPendingServices } from "../../services/services.service";
import { reviewServiceListing, resolveCategory } from "../../services/admin-moderation.service";
import { safeEmit } from "../../lib/socket";
import { BooleanDecisionSchema } from "../../schema/marketplace.schema";

export async function listPendingServices(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const result = await adminListPendingServices(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/services/:id/review ──────────────────────────────────────────
export async function reviewService(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes } = BooleanDecisionSchema.parse(req.body);
    const result = await reviewServiceListing(req.params.id as string, (req as AuthenticatedRequest).user.id, approve, adminNotes);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/categories/suggestions ─────────────────────────────────────────
export async function listCategorySuggestions(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const where = { status: "PENDING" as const };
    const [suggestions, total] = await Promise.all([
      prisma.categorySuggested.findMany({
        where,
        include: { submitter: { select: { id: true, name: true } } },
        orderBy: { submittedAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.categorySuggested.count({ where }),
    ]);
    res.json({
      success: true,
      data: suggestions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/categories/suggestions/:id ────────────────────────────────────
async function resolveCategorySuggestionLegacy(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve } = BooleanDecisionSchema.parse(req.body);
    const suggestion = await prisma.categorySuggested.update({
      where: { id: req.params.id as string },
      data: { status: approve ? "APPROVED" : "REJECTED", reviewedAt: new Date() },
      include: { submitter: { select: { id: true, name: true } } },
    });

    if (approve) {
      // 1. Add to live categories list
      await prisma.category.create({
        data: { name: suggestion.name, isActive: true },
      });

      // 2. Part 18: Auto-post to Community Hub as a system announcement
      // Notify the submitter that their suggestion was approved
      await prisma.notification.create({
        data: {
          userId: suggestion.submitterId,
          title: `🎉 Category "${suggestion.name}" Approved!`,
          body: `Your suggested category "${suggestion.name}" has been added to the ServiceHub Cordova marketplace. Providers can now list services under this category.`,
          link: `/seeker/suggest-category`
        },
      });
      safeEmit(`user:${suggestion.submitterId}`, "notification", { title: `🎉 Category "${suggestion.name}" Approved!` });
    } else {
      // Notify submitter of rejection
      await prisma.notification.create({
        data: {
          userId: suggestion.submitterId,
          title: `Category Suggestion Not Approved`,
          body: `Your suggested category "${suggestion.name}" was not approved at this time. You may suggest a different category.`,
          link: `/seeker/suggest-category`
        },
      });
      safeEmit(`user:${suggestion.submitterId}`, "notification", { title: `Category Suggestion Not Approved` });
    }

    res.json({ success: true, data: suggestion });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/reports ────────────────────────────────────────────────────────
export async function resolveCategorySuggestion(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes } = BooleanDecisionSchema.parse(req.body);
    const suggestion = await resolveCategory(
      req.params.id as string,
      (req as AuthenticatedRequest).user.id,
      approve,
      adminNotes,
    );
    res.json({ success: true, data: suggestion });
  } catch (error) {
    next(error);
  }
}
