import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { listAdminServices } from "../../services/services.service";
import { createManagedCategory, listManagedCategories, removePublishedService, restoreRemovedService, updateManagedCategory } from "../../services/admin-moderation.service";

import { AdminCategoryCreateSchema, AdminCategoryUpdateSchema } from "../../schema/marketplace.schema";

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
