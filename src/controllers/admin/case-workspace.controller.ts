import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { getModerationCase, listModerationCases, startModerationReview } from "../../services/admin-case-workspace.service";

export const CaseQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  view: z.enum(["active", "history", "all"]).default("active"),
  concern: z.enum(["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE", "SCAM_OR_FRAUD", "INAPPROPRIATE_BEHAVIOR", "OVERPRICING", "NO_SHOW"]).optional(),
  type: z.enum(["COMPLETION_DISPUTE", "SAFETY", "CANCELLATION_ESCALATION", "COMPLETION_ESCALATION"]).optional(),
  status: z.enum(["PENDING", "UNDER_REVIEW", "RESOLVED", "DISMISSED"]).optional(),
  payment: z.enum(["GCash", "On-site Cash"]).optional(),
  search: z.string().trim().max(150).optional(), sort: z.enum(["attention", "oldest", "newest"]).default("attention"),
  userId: z.string().max(100).optional(), bookingId: z.string().max(100).optional(),
});
const keySchema = z.object({ source: z.enum(["report", "completion"]), id: z.string().min(1).max(100) });
export async function listCases(req: Request, res: Response, next: NextFunction) {
  try { const result = await listModerationCases(CaseQuerySchema.parse(req.query)); res.json({ success: true, data: result.items, summary: result.summary, pagination: result.pagination }); } catch (e) { next(e); }
}
export async function getCase(req: Request, res: Response, next: NextFunction) {
  try { const key = keySchema.parse(req.params); res.json({ success: true, data: await getModerationCase(key.source, key.id) }); } catch (e) { next(e); }
}
export async function reviewCase(req: Request, res: Response, next: NextFunction) {
  try { const key = keySchema.parse(req.params); res.json({ success: true, data: await startModerationReview(key.source, key.id, (req as AuthenticatedRequest).user.id) }); } catch (e) { next(e); }
}
