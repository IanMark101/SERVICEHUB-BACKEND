import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { AdminCompletionEscalationResolutionSchema } from "../../schema/marketplace.schema";
import { listCompletionEscalations, resolveCompletionEscalation } from "../../services/completion-escalation.service";

export async function listAdminCompletionEscalations(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const result = await listCompletionEscalations(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) { next(error); }
}
export async function resolveAdminCompletionEscalation(req: Request, res: Response, next: NextFunction) {
  try {
    const input = AdminCompletionEscalationResolutionSchema.parse(req.body);
    const result = await resolveCompletionEscalation({ escalationId: req.params.id as string, adminId: (req as AuthenticatedRequest).user.id, ...input });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}
