import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { listAdminServices } from "../../services/services.service";
import { createManagedCategory, listManagedCategories, removePublishedService, restoreRemovedService, resolveCategory, updateManagedCategory } from "../../services/admin-moderation.service";
import { safeEmit } from "../../lib/socket";
import { AdminCategoryCreateSchema, AdminCategoryUpdateSchema, BooleanDecisionSchema } from "../../schema/marketplace.schema";

const ADMIN_SERVICE_STATUSES = ["LIVE", "ACTIVE", "INACTIVE", "SUSPENDED", "REJECTED"] as const;

export async function listServices(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const requestedStatus = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
    if (requestedStatus && !ADMIN_SERVICE_STATUSES.includes(requestedStatus as typeof ADMIN_SERVICE_STATUSES[number])) {
      return res.status(400).json({ success: false, error: "Invalid service status filter" });
    }
    const result = await listAdminServices(
      page,
      limit,
      requestedStatus as typeof ADMIN_SERVICE_STATUSES[number] | undefined,
    );
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (err) {
    next(err);
  }
}

export async function removeServiceContent(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 3 || reason.length > 1000) return res.status(400).json({ success: false, error: "An Admin reason of 3–1000 characters is required." });
    const service = await removePublishedService(req.params.id as string, (req as AuthenticatedRequest).user.id, reason);
    res.json({ success: true, data: service });
  } catch (error) { next(error); }
}

export async function restoreServiceContent(req: Request, res: Response, next: NextFunction) {
  try {
    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 3 || reason.length > 1000) return res.status(400).json({ success: false, error: "An Admin reason of 3–1000 characters is required." });
    const service = await restoreRemovedService(req.params.id as string, (req as AuthenticatedRequest).user.id, reason);
    res.json({ success: true, data: service });
  } catch (error) { next(error); }
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

export async function listCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const result = await listManagedCategories(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function createCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const input = AdminCategoryCreateSchema.parse(req.body);
    const category = await createManagedCategory((req as AuthenticatedRequest).user.id, input);
    res.status(201).json({ success: true, data: category });
  } catch (error) { next(error); }
}

export async function updateCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const input = AdminCategoryUpdateSchema.parse(req.body);
    const result = await updateManagedCategory(
      req.params.id as string,
      (req as AuthenticatedRequest).user.id,
      input,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
