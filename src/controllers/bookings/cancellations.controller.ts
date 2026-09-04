import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import {
  createDirectRequest,
  joinWaitlist,
  markJobComplete,
} from "../../services/bookings.service";
import { createPaymentIntent, getPaymentIntent, createPaymentMethod, attachPaymentMethod } from "../../services/paymongo.service";
import { assertDistinctAccounts } from "../../utils/security";
import {
  DirectBookingSchema,
  InitiatePaymentSchema,
  ConfirmOnlineBookingSchema,
  WaitlistSchema,
  DisputeSchema,
  CancellationRequestSchema,
  CancellationResponseSchema,
  DirectResponseSchema,
  DirectOfferSchema,
  BooleanDecisionSchema,
} from "../../schema/marketplace.schema";
import { prisma } from "../../lib/prisma";

// ── POST /bookings/direct ─────────────────────────────────────────────────────
// Cash / Direct Arrangement — NEVER touches the queue

export async function cancelBookingHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const id = req.params.id as string;
    const { reason } = CancellationRequestSchema.parse(req.body || {});
    const { requestCancellation } = await import("../../services/cancellation.service");
    const result = await requestCancellation(id, user.id, reason);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function respondCancellationRequestHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const id = req.params.id as string;
    const { approve, responderNote, providerNote } = CancellationResponseSchema.parse(req.body);
    const { respondToCancellationRequest } = await import("../../services/cancellation.service");
    const result = await respondToCancellationRequest(id, user.id, approve, responderNote || providerNote);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function escalateCancellationRequestHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const id = req.params.id as string;
    const { escalateCancellationRequest } = await import("../../services/cancellation.service");
    const result = await escalateCancellationRequest(id, user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function adminResolveCancellationRequestHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as string;
    const { approve, adminNotes: adminNote } = BooleanDecisionSchema.parse(req.body);
    const { adminResolveCancellationRequest } = await import("../../services/cancellation.service");
    const result = await adminResolveCancellationRequest(id, approve, adminNote, (req as AuthenticatedRequest).user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
