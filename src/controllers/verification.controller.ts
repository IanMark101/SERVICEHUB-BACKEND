import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import {
  submitVerification,
  getVerificationStatus,
  listPendingVerifications,
  reviewVerification,
  accessVerificationProof,
  getVerificationPrivacyNotice,
} from "../services/verification.service";
import { VerificationProofAccessSchema, VerificationSubmissionSchema } from "../schema/marketplace.schema";
import { BooleanDecisionSchema } from "../schema/marketplace.schema";

// ── POST /verifications/submit ────────────────────────────────────────────────

export async function submit(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { proofs, privacyNoticeVersion, privacyAcknowledged } = VerificationSubmissionSchema.parse(req.body);

    const verification = await submitVerification(user.id, proofs, privacyNoticeVersion, privacyAcknowledged);
    res.status(201).json({ success: true, data: verification });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

export async function privacyNotice(_req: Request, res: Response) {
  res.json({ success: true, data: getVerificationPrivacyNotice() });
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
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const result = await listPendingVerifications(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/verifications/:id ────────────────────────────────────────────

export async function adminReview(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { approve, adminNotes } = BooleanDecisionSchema.parse(req.body);

    const result = await reviewVerification(id as string, admin.id, approve, adminNotes);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function adminAccessProof(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const { action } = VerificationProofAccessSchema.parse(req.query);
    const result = await accessVerificationProof(
      req.params.id as string,
      req.params.proofId as string,
      admin.id,
      action,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
