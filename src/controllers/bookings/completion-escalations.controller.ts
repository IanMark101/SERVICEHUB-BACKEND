import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { CompletionEscalationSchema } from "../../schema/marketplace.schema";
import { createCompletionEscalation } from "../../services/completion-escalation.service";

export async function escalateCompletion(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = CompletionEscalationSchema.parse(req.body);
    const result = await createCompletionEscalation(req.params.id as string, (req as AuthenticatedRequest).user.id, reason);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
