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

export async function bookDirect(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId, schedule, message, scheduledDate, scheduledTime } = DirectBookingSchema.parse(req.body);

    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      select: { providerId: true },
    });

    if (!service) {
      return res.status(404).json({ success: false, error: "Service not found" });
    }

    const directRequest = await createDirectRequest({
      seekerId: user.id,
      providerId: service.providerId,
      serviceId,
      schedule,
      message,
      scheduledDate: scheduledDate || undefined,
      scheduledTime: scheduledTime || undefined,
    });

    res.status(201).json({
      success: true,
      message: "Direct Arrangement request sent. Provider will accept or decline.",
      data: directRequest,
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

// ── POST /bookings/initiate-payment ──────────────────────────────────────────
export async function respondDirectRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { accept } = DirectResponseSchema.parse(req.body);

    const { respondToDirectBookingService } = await import("../../services/bookings.service");
    const result = await respondToDirectBookingService(id as string, user.id, accept);

    res.json({
      success: true,
      message: accept ? "Direct arrangement accepted." : "Direct arrangement declined.",
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /bookings/direct-from-offer ──────────────────────────────────────────
export async function bookDirectFromOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { offerId } = DirectOfferSchema.parse(req.body);

    const { createDirectFromOfferService } = await import("../../services/bookings.service");
    const booking = await createDirectFromOfferService(offerId, user.id);

    res.status(201).json({
      success: true,
      message: "Bid accepted under Cash Arrangement.",
      data: booking,
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /bookings/queue/:id/start ───────────────────────────────────────────
