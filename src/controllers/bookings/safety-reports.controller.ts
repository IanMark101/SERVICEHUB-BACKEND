import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { SafetyReportSchema } from "../../schema/marketplace.schema";
import { createSafetyReport } from "../../services/safety-report.service";

export async function reportBookingSafety(req: Request, res: Response, next: NextFunction) {
  try {
    const input = SafetyReportSchema.parse(req.body);
    const result = await createSafetyReport({
      bookingId: req.params.id as string,
      reporterId: (req as AuthenticatedRequest).user.id,
      ...input,
    });
    res.status(result.created ? 201 : 200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
