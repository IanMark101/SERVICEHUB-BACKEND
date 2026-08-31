import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import {
  createDirectRequest,
  addToQueue,
  joinWaitlist,
  cancelQueueEntry,
  markJobComplete,
} from "../services/bookings.service";
import { createPaymentIntent, getPaymentIntent, createPaymentMethod, attachPaymentMethod } from "../services/paymongo.service";
import { assertDistinctAccounts } from "../utils/security";
import { DirectBookingSchema, InitiatePaymentSchema, ConfirmOnlineBookingSchema, WaitlistSchema, DisputeSchema, CancellationRequestSchema, CancellationResponseSchema, DirectResponseSchema, DirectOfferSchema, BooleanDecisionSchema } from "../schema/marketplace.schema";
import { prisma } from "../lib/prisma";

// ── POST /bookings/direct ─────────────────────────────────────────────────────
// Cash / Direct Arrangement — NEVER touches the queue

export async function bookDirect(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId, schedule, message, scheduledDate, scheduledTime } = DirectBookingSchema.parse(req.body);

    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      select: { providerId: true, price: true },
    });

    if (!service) {
      return res.status(404).json({ success: false, error: "Service not found" });
    }

    const directRequest = await createDirectRequest({
      seekerId: user.id,
      providerId: service.providerId,
      serviceId,
      // Direct-booking prices belong to the provider's active listing. They are
      // never accepted from the seeker request body.
      agreedPrice: Number(service.price),
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

export async function initiatePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId, offerId, paymentMethodType } = InitiatePaymentSchema.parse(req.body);

    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      select: { providerId: true, price: true, paymentMethods: true, status: true, isAvailable: true },
    });

    if (!service) {
      return res.status(404).json({ success: false, error: "Service not found" });
    }

    if (service.status !== "ACTIVE" || !service.isAvailable) {
      return res.status(400).json({ success: false, error: "This service is not available for online booking" });
    }

    assertDistinctAccounts(user.id, service.providerId, "book service");

    let expectedAmount = Number(service.price);
    if (offerId) {
      const offer = await prisma.offer.findUnique({
        where: { id: offerId },
        include: { request: { select: { seekerId: true } } },
      });
      if (!offer || offer.status !== "ACCEPTED" || offer.request.seekerId !== user.id || offer.providerId !== service.providerId) {
        return res.status(400).json({ success: false, error: "Accepted offer does not match this service" });
      }
      expectedAmount = Number(offer.offeredPrice);
    }

    if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
      return res.status(400).json({ success: false, error: "The booking amount is invalid" });
    }

    const normalizedPaymentMethod = paymentMethodType || "gcash";
    const paymentMethods = service.paymentMethods as { gcash?: boolean; maya?: boolean };
    if ((normalizedPaymentMethod === "gcash" && !paymentMethods?.gcash) ||
        (normalizedPaymentMethod === "paymaya" && !paymentMethods?.maya) ||
        !["gcash", "paymaya"].includes(normalizedPaymentMethod)) {
      return res.status(400).json({ success: false, error: "This payment method is not accepted for the service" });
    }

    // Prevent duplicate concurrent payments / bookings on the same service
    const activeExistingBooking = await prisma.booking.findFirst({
      where: {
        seekerId: user.id,
        serviceId,
        status: {
          in: ["PENDING_APPROVAL", "WAITING", "ONGOING", "ACCEPTED", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"]
        }
      }
    });

    if (activeExistingBooking) {
      return res.status(400).json({
        success: false,
        error: "You already have an active booking for this service in progress. Please check your Activity tab."
      });
    }

    const intent = await createPaymentIntent({
      amount: expectedAmount,
      description: `ServiceHub Cordova booking for ${serviceId}`,
      metadata: {
        servicehub_seeker_id: user.id,
        servicehub_service_id: serviceId,
        servicehub_offer_id: offerId || "",
        servicehub_expected_amount: expectedAmount.toFixed(2),
        servicehub_payment_method: normalizedPaymentMethod,
      },
    });

    let redirectUrl: string | undefined;

    if (paymentMethodType) {
      // 1. Create Payment Method
      const methodId = await createPaymentMethod(normalizedPaymentMethod);
      
      // 2. Attach to Intent
      const retUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/seeker/seeker-activity`;
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
        expectedAmount,
      },
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
    next(err);
  }
}

// ── POST /bookings/confirm-online ─────────────────────────────────────────────

export async function confirmOnlineBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { serviceId, paymentIntentId, offerId } = ConfirmOnlineBookingSchema.parse(req.body);

    const intent = await getPaymentIntent(paymentIntentId);
    const expectedAmount = offerId
      ? Number((await prisma.offer.findUnique({ where: { id: offerId }, select: { offeredPrice: true } }))?.offeredPrice)
      : Number((await prisma.service.findUnique({ where: { id: serviceId }, select: { price: true } }))?.price);

    const metadata = intent.metadata;
    const isBoundToBooking =
      intent.status === "succeeded" &&
      intent.currency === "PHP" &&
      Number.isFinite(expectedAmount) &&
      Math.abs(intent.amount - expectedAmount) < 0.005 &&
      metadata.servicehub_seeker_id === user.id &&
      metadata.servicehub_service_id === serviceId &&
      (metadata.servicehub_offer_id || "") === (offerId || "") &&
      metadata.servicehub_expected_amount === expectedAmount.toFixed(2);

    if (!isBoundToBooking) {
      return res.status(402).json({
        success: false,
        error: "Payment does not match this booking. Please initiate and complete payment again.",
        code: "PAYMENT_NOT_CONFIRMED",
      });
    }

    const paymentMethodByProvider: Record<string, "GCash" | "Maya" | "Card"> = {
      gcash: "GCash",
      paymaya: "Maya",
      card: "Card",
    };
    const trustedPaymentMethod = paymentMethodByProvider[metadata.servicehub_payment_method];
    if (!trustedPaymentMethod) {
      return res.status(402).json({ success: false, error: "Payment method is invalid", code: "PAYMENT_NOT_CONFIRMED" });
    }

    const { queueEntry, isImmediate } = await addToQueue({
      serviceId,
      seekerId: user.id,
      paymentId: paymentIntentId,
      offerId,
      paymentMethod: trustedPaymentMethod,
    });

    res.status(201).json({
      success: true,
      message: "Payment secured in Escrow! Your booking request has been sent to the provider for confirmation.",
      data: queueEntry,
    });
  } catch (err: any) {
    if (err.name === "ZodError") {
      return res.status(400).json({ success: false, error: "Validation failed", errors: err.errors });
    }
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
          { seekerId: user.id, hiddenBySeeker: false },
          { providerId: user.id, hiddenByProvider: false }
        ]
      },
      include: {
        seeker: {
          select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true, verificationStatus: true }
        },
        provider: {
          select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true, verificationStatus: true }
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
          select: {
            message: true,
            agreedPrice: true,
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
          {
            seekerId: user.id,
            OR: [
              { bookingId: null },
              { booking: { hiddenBySeeker: false } }
            ]
          },
          {
            providerId: user.id,
            OR: [
              { bookingId: null },
              { booking: { hiddenByProvider: false } }
            ]
          }
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

// ── PATCH /bookings/:id/hide ──────────────────────────────────────────────────

export async function hideBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { hideBookingService } = await import("../services/bookings.service");
    const result = await hideBookingService(id as string, user.id);
    res.json({ success: true, message: "Booking removed from your view.", data: result });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /bookings/direct/:id/respond ────────────────────────────────────────

export async function respondDirectRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { id } = req.params;
    const { accept } = DirectResponseSchema.parse(req.body);

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
    const { offerId } = DirectOfferSchema.parse(req.body);

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
    const { reason, description, evidenceUrl } = DisputeSchema.parse(req.body);

    const { disputeJobService } = await import("../services/bookings.service");
    const report = await disputeJobService(id as string, user.id, reason, description, evidenceUrl);

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
    const { reason } = CancellationRequestSchema.parse(req.body);
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
    const { approve, providerNote } = CancellationResponseSchema.parse(req.body);
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
    const { approve, adminNotes: adminNote } = BooleanDecisionSchema.parse(req.body);
    const { adminResolveCancellationRequest } = await import("../services/cancellation.service");
    const result = await adminResolveCancellationRequest(id, approve, adminNote);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
