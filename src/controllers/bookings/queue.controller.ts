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

export async function joinWaitlistHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId } = WaitlistSchema.parse(req.body);
    const entry = await joinWaitlist(serviceId, user.id);
    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
}

// ── DELETE /bookings/queue/:id ────────────────────────────────────────────────
export async function cancelQueue(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { reason } = CancellationRequestSchema.parse(req.body);
    const queueEntry = await prisma.queue.findUnique({
      where: { id: req.params.id as string },
      select: { bookingId: true, seekerId: true },
    });
    if (!queueEntry?.bookingId || queueEntry.seekerId !== user.id) {
      const error = new Error("Queue entry not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    const { requestCancellation } = await import("../../services/cancellation.service");
    const result = await requestCancellation(queueEntry.bookingId, user.id, reason);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /bookings/queue/:id/complete ────────────────────────────────────────
// Provider marks job done → seeker gets "Awaiting Confirmation" notification
export async function completeJob(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const cs = await markJobComplete(req.params.id as string, user.id);
    res.json({ success: true, data: cs });
  } catch (err) {
    next(err);
  }
}

// ── GET /bookings/my-engagements ──────────────────────────────────────────────
