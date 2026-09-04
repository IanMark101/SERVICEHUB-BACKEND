import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { ReportResolutionSchema } from "../../schema/marketplace.schema";
import { listAdminReports, resolveAdminReport } from "../../services/admin-report.service";

export async function listReports(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(25, Number(req.query.limit) || 10));
    const result = await listAdminReports(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function resolveReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { action, adminNotes } = ReportResolutionSchema.parse(req.body);
    const result = await resolveAdminReport(
      req.params.id as string,
      (req as AuthenticatedRequest).user.id,
      action,
      adminNotes,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
