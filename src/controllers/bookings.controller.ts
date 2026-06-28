import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import {
  createDirectRequest,
  addToQueue,
  joinWaitlist,
  cancelQueueEntry,
  markJobComplete,
} from "../services/bookings.service";
import { createPaymentIntent, verifyPaymentSuccess, createPaymentMethod, attachPaymentMethod } from "../services/paymongo.service";

// ── POST /bookings/direct ─────────────────────────────────────────────────────
// Cash / Direct Arrangement — NEVER touches the queue

export async function bookDirect(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId, agreedPrice, schedule, message } = req.body;

    if (!serviceId || !agreedPrice) {
      return res.status(400).json({ success: false, error: "serviceId and agreedPrice are required" });
    }

    const { prisma } = await import("../lib/prisma");
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
      agreedPrice: parseFloat(agreedPrice),
      schedule,
      message,
    });

    res.status(201).json({
      success: true,
      message: "Direct Arrangement request sent. Provider will accept or decline.",
      data: directRequest,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /bookings/initiate-payment ──────────────────────────────────────────

export async function initiatePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId, amount, description, paymentMethodType, returnUrl } = req.body;

    if (!serviceId || !amount) {
      return res.status(400).json({ success: false, error: "serviceId and amount are required" });
    }

    const intent = await createPaymentIntent({
      amount: parseFloat(amount),
      description: description || "ServiceHub Cordova booking",
    });

    let redirectUrl: string | undefined;

    if (paymentMethodType) {
      // 1. Create Payment Method
      const methodId = await createPaymentMethod(paymentMethodType);
      
      // 2. Attach to Intent
      const retUrl = returnUrl || `${process.env.FRONTEND_URL || "http://localhost:3000"}/seeker/seeker-activity`;
      const attachment = await attachPaymentMethod({
        paymentIntentId: intent.id,
        paymentMethodId: methodId,
        clientKey: intent.clientKey,
        returnUrl: retUrl,
      });

      if (attachment.status === "awaiting_next_action" && attachment.nextAction?.type === "redirect") {
        redirectUrl = attachment.nextAction.redirect.url;
      }
    }

    res.json({
      success: true,
      data: {
        paymentIntentId: intent.id,
        clientKey: intent.clientKey,
        redirectUrl,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /bookings/confirm-online ─────────────────────────────────────────────

export async function confirmOnlineBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId, paymentIntentId, offerId } = req.body;

    if (!serviceId || !paymentIntentId) {
      return res.status(400).json({ success: false, error: "serviceId and paymentIntentId are required" });
    }

    const paid = await verifyPaymentSuccess(paymentIntentId);
    if (!paid) {
      return res.status(402).json({
        success: false,
        error: "Payment not confirmed. Please complete payment before booking.",
        code: "PAYMENT_NOT_CONFIRMED",
      });
    }

    const { queueEntry, isImmediate } = await addToQueue({
      serviceId,
      seekerId: user.id,
      paymentId: paymentIntentId,
      offerId,
    });

    res.status(201).json({
      success: true,
      message: isImmediate
        ? "You are next! The provider will start your service now."
        : `You are in the queue at position ${queueEntry.position}. Estimated wait: ${queueEntry.estimatedWait} minutes.`,
      data: queueEntry,
    });
  } catch (err: any) {
    if (err.code === "QUEUE_FULL") {
      return res.status(409).json({
        success: false,
        error: err.message,
        code: "QUEUE_FULL",
        hint: "Use the Notify Me button to join the waitlist.",
      });
    }
    next(err);
  }
}

// ── POST /bookings/waitlist ────────────────────────────────────────────────────

export async function joinWaitlistHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId } = req.body;
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
    const result = await cancelQueueEntry(req.params.id as string, user.id);
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

export async function getMyEngagements(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { prisma } = await import("../lib/prisma");

    const bookings = await prisma.booking.findMany({
      where: {
        OR: [
          { seekerId: user.id },
          { providerId: user.id }
        ]
      },
      include: {
        seeker: {
          select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true }
        },
        provider: {
          select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true }
        },
        service: {
          select: { id: true, title: true, description: true, price: true, priceType: true, estimatedDurationMins: true }
        },
        offer: {
          include: {
            request: {
              select: { title: true }
            }
          }
        },
        directRequest: {
          include: {
            service: {
              select: { title: true }
            }
          }
        },
        queue: true,
        reports: true,
        cancellationRequests: {
          orderBy: { createdAt: "desc" }
        },
        messages: {
          orderBy: { createdAt: "asc" }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    const completedServices = await prisma.completedService.findMany({
      where: {
        OR: [
          { seekerId: user.id },
          { providerId: user.id }
        ]
      },
      include: {
        seeker: {
          select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
        },
        provider: {
          select: { id: true, name: true, email: true, phone: true, avatarUrl: true, trustScore: true }
        },
        reviews: true,
        booking: {
          include: {
            service: { select: { title: true } },
            offer: { include: { request: { select: { title: true } } } },
            directRequest: { include: { service: { select: { title: true } } } }
          }
        }
      },
      orderBy: { completedAt: "desc" }
    });

    res.json({
      success: true,
      data: {
        bookings,
        completedServices
      }
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /bookings/direct/:id/respond ────────────────────────────────────────

export async function respondDirectRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { accept } = req.body;

    if (typeof accept !== "boolean") {
      return res.status(400).json({ success: false, error: "accept must be a boolean" });
    }

    const { respondToDirectBookingService } = await import("../services/bookings.service");
    const result = await respondToDirectBookingService(id as string, user.id, accept);

    res.json({
      success: true,
      message: accept ? "Direct arrangement accepted." : "Direct arrangement declined.",
      data: result
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /bookings/direct-from-offer ──────────────────────────────────────────

export async function bookDirectFromOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { offerId } = req.body;

    if (!offerId) {
      return res.status(400).json({ success: false, error: "offerId is required" });
    }

    const { createDirectFromOfferService } = await import("../services/bookings.service");
    const booking = await createDirectFromOfferService(offerId, user.id);

    res.status(201).json({
      success: true,
      message: "Bid accepted under Cash Arrangement.",
      data: booking
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /bookings/queue/:id/start ───────────────────────────────────────────

export async function startJob(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;

    const { providerStartJob } = await import("../services/bookings.service");
    const result = await providerStartJob(id as string, user.id);

    res.json({
      success: true,
      message: "Job started successfully.",
      data: result
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

    const { providerRemoveQueueEntry } = await import("../services/bookings.service");
    const result = await providerRemoveQueueEntry(id as string, user.id);

    res.json({
      success: true,
      message: "Booking removed from queue.",
      data: result
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
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, error: "reason is required" });
    }

    const { disputeJobService } = await import("../services/bookings.service");
    const report = await disputeJobService(id as string, user.id, reason);

    res.json({
      success: true,
      message: "Dispute report filed successfully.",
      data: report
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

    const { confirmCompletionService } = await import("../services/bookings.service");
    const result = await confirmCompletionService(id as string, user.id);

    res.json({
      success: true,
      message: "Service completion confirmed. Funds released.",
      data: result
    });
  } catch (err) {
    next(err);
  }
}

// ── Cancellation Policy Controllers ───────────────────────────────────────────

export async function cancelBookingHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const id = req.params.id as string;
    const { reason } = req.body;
    const { requestCancellation } = await import("../services/cancellation.service");
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
    const { approve, providerNote } = req.body;
    if (typeof approve !== "boolean") {
      return res.status(400).json({ success: false, error: "approve must be a boolean" });
    }
    const { respondToCancellationRequest } = await import("../services/cancellation.service");
    const result = await respondToCancellationRequest(id, user.id, approve, providerNote);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function escalateCancellationRequestHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const id = req.params.id as string;
    const { escalateCancellationRequest } = await import("../services/cancellation.service");
    const result = await escalateCancellationRequest(id, user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function adminResolveCancellationRequestHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as string;
    const { approve, adminNote } = req.body;
    if (typeof approve !== "boolean") {
      return res.status(400).json({ success: false, error: "approve must be a boolean" });
    }
    const { adminResolveCancellationRequest } = await import("../services/cancellation.service");
    const result = await adminResolveCancellationRequest(id, approve, adminNote);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
