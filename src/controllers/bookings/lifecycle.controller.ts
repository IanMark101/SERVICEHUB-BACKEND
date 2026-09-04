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

export async function startJob(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;

    const { providerStartJob } = await import("../../services/bookings.service");
    const result = await providerStartJob(id as string, user.id);

    res.json({
      success: true,
      message: "Job started successfully.",
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /bookings/queue/:id/provider ───────────────────────────────────────
export async function providerRemoveFromQueue(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { reason } = CancellationRequestSchema.parse(req.body);
    const queueEntry = await prisma.queue.findUnique({
      where: { id: id as string },
      select: { bookingId: true, service: { select: { providerId: true } } },
    });
    if (!queueEntry?.bookingId || queueEntry.service.providerId !== user.id) {
      const error = new Error("Queue entry not found or access denied") as Error & { status?: number };
      error.status = 404;
      throw error;
    }

    const { requestCancellation } = await import("../../services/cancellation.service");
    const result = await requestCancellation(queueEntry.bookingId, user.id, reason);

    res.json({
      success: true,
      message: result.immediate ? "Booking cancelled." : "Cancellation request sent.",
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /bookings/:id/dispute ────────────────────────────────────────────────
export async function disputeJob(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { reason, description, evidenceUrl } = DisputeSchema.parse(req.body);

    const { disputeJobService } = await import("../../services/bookings.service");
    const report = await disputeJobService(id as string, user.id, reason, description, evidenceUrl);

    res.json({
      success: true,
      message: "Dispute report filed successfully.",
      data: report,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /bookings/:id/confirm ────────────────────────────────────────────────
export async function confirmCompletion(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;

    const { confirmCompletionService } = await import("../../services/bookings.service");
    const result = await confirmCompletionService(id as string, user.id);

    res.json({
      success: true,
      message: "Service completion confirmed. Funds released.",
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

// ── Cancellation Policy Controllers ───────────────────────────────────────────
