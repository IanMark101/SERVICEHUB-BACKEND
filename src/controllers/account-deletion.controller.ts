import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { DeleteOwnAccountSchema } from "../schema/account-deletion.schema";
import {
  createDeletionGoogleChallenge,
  getAccountDeletionEligibility,
  deleteOwnAccount,
} from "../services/account-deletion.service";
import { env } from "../config/env";

export async function deleteAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const input = DeleteOwnAccountSchema.parse(req.body);
    const user = (req as AuthenticatedRequest).user;
    const sessionId = (req as AuthenticatedRequest).sessionId;
    if (!sessionId) return res.status(401).json({ success: false, error: "Sign in again before deleting your account." });
    const result = await deleteOwnAccount(user.id, sessionId, input);
    if (!result.deleted) return res.status(409).json({ success: false, code: "ACCOUNT_DELETION_BLOCKED", error: "Resolve the items in your checklist before deleting your account.", data: result.eligibility });
    res.clearCookie("refreshToken", { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: env.NODE_ENV === "production" ? "none" : "lax", path: "/" });
    res.json({ success: true, data: { deleted: true }, message: "Your account and its associated database records have been permanently deleted." });
  } catch (error) {
    next(error);
  }
}

export async function readDeletionEligibility(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await getAccountDeletionEligibility((req as AuthenticatedRequest).user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function startDeletionGoogleVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const sessionId = (req as AuthenticatedRequest).sessionId;
    if (!sessionId) return res.status(401).json({ success: false, error: "Sign in again before verifying your account." });
    const result = createDeletionGoogleChallenge(user.id, sessionId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
