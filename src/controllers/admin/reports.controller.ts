import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { PrivateEvidenceAccessSchema, ReportResolutionSchema } from "../../schema/marketplace.schema";
import { listAdminReports, resolveAdminReport } from "../../services/admin-report.service";
import { accessSafetyReportEvidence } from "../../services/safety-report.service";

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

export async function accessReportEvidence(req: Request, res: Response, next: NextFunction) {
  try {
    const { action } = PrivateEvidenceAccessSchema.parse(req.query);
    const result = await accessSafetyReportEvidence(req.params.id as string, (req as AuthenticatedRequest).user.id, action);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function resolveReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { outcome, penaltyAction, adminNotes } = ReportResolutionSchema.parse(req.body);
    const result = await resolveAdminReport(
      req.params.id as string,
      (req as AuthenticatedRequest).user.id,
      outcome,
      adminNotes,
      penaltyAction,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
