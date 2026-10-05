import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { listMyContentCases, submitContentCase } from "../services/content-moderation-cases.service";

const Submission = z.object({
  caseType: z.enum(["REPORT", "APPEAL"]),
  contentType: z.enum(["SERVICE_LISTING", "SERVICE_REQUEST"]),
  resourceId: z.string().cuid().optional(),
  reason: z.string().trim().min(10).max(1000),
}).strict();

export async function createContentCase(req: Request, res: Response, next: NextFunction) {
  try {
    const input = Submission.parse(req.body);
    const submitted = await submitContentCase((req as AuthenticatedRequest).user.id, input);
    res.status(201).json({ success: true, data: submitted });
  } catch (error) { next(error); }
}

export async function getMyContentCases(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await listMyContentCases((req as AuthenticatedRequest).user.id) }); }
  catch (error) { next(error); }
}
