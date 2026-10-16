import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { listMyContentCases, submitContentCase } from "../services/content-moderation-cases.service";
import { ContentCaseSubmissionSchema } from "../schema/content-case-submission.schema";

export async function createContentCase(req: Request, res: Response, next: NextFunction) {
  try {
    const input = ContentCaseSubmissionSchema.parse(req.body);
    const submitted = await submitContentCase((req as AuthenticatedRequest).user.id, input);
    res.status(201).json({ success: true, data: submitted });
  } catch (error) { next(error); }
}

export async function getMyContentCases(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await listMyContentCases((req as AuthenticatedRequest).user.id) }); }
  catch (error) { next(error); }
}
