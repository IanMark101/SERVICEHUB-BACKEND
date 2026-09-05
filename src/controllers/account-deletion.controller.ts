import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { AccountDeletionRequestSchema } from "../schema/marketplace.schema";
import {
  cancelAccountDeletionRequest,
  getAccountDeletionRequest,
  requestAccountDeletion,
} from "../services/account-deletion.service";

export async function createAccountDeletionRequest(req: Request, res: Response, next: NextFunction) {
  try {
    AccountDeletionRequestSchema.parse(req.body);
    const result = await requestAccountDeletion((req as AuthenticatedRequest).user.id);
    res.status(202).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function readAccountDeletionRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await getAccountDeletionRequest((req as AuthenticatedRequest).user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function cancelDeletionRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await cancelAccountDeletionRequest((req as AuthenticatedRequest).user.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
