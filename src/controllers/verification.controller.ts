import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import {
  submitVerification,
  getVerificationStatus,
  listPendingVerifications,
  reviewVerification,
} from "../services/verification.service";

// ── POST /verifications/submit ────────────────────────────────────────────────

export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { proofs } = req.body as {
      proofs: { fileUrl: string; documentType: string }[];
    };

    const verification = await submitVerification(user.id, proofs || []);
    res.status(201).json({ success: true, data: verification });
  } catch (err) {
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
