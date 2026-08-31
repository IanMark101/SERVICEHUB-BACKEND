import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import {
  submitVerification,
  getVerificationStatus,
  listPendingVerifications,
  reviewVerification,
} from "../services/verification.service";
import { VerificationSubmissionSchema } from "../schema/marketplace.schema";

// ── POST /verifications/submit ────────────────────────────────────────────────

export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { proofs } = VerificationSubmissionSchema.parse(req.body);

    const verification = await submitVerification(user.id, proofs);
    res.status(201).json({ success: true, data: verification });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

// ── GET /verifications/status ──────────────────────────────────────────────────

export async function getStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const status = await getVerificationStatus(user.id);
    res.json({ success: true, data: status });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/verifications ───────────────────────────────────────────────────

export async function adminList(req: Request, res: Response, next: NextFunction) {
  try {
    const list = await listPendingVerifications();
    res.json({ success: true, data: list });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/verifications/:id ────────────────────────────────────────────

export async function adminReview(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { approve, adminNotes } = req.body as { approve: boolean; adminNotes?: string };

    const result = await reviewVerification(id as string, admin.id, approve, adminNotes);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
