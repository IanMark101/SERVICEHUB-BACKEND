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

export async function getMyEngagements(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;

    const bookings = await prisma.booking.findMany({
      where: {
        OR: [
          { seekerId: user.id, hiddenBySeeker: false },
          { providerId: user.id, hiddenByProvider: false },
        ],
      },
      include: {
        seeker: {
          select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true, verificationStatus: true },
        },
        provider: {
          select: { id: true, name: true, email: true, phone: true, location: true, avatarUrl: true, trustScore: true, verificationStatus: true },
        },
        service: {
          select: { id: true, title: true, description: true, price: true, priceType: true, estimatedDurationMins: true },
        },
        offer: {
          include: {
            request: {
              select: { title: true },
            },
          },
        },
        directRequest: {
          select: {
            message: true,
            agreedPrice: true,
            service: {
              select: { title: true },
            },
          },
        },
        queue: true,
        reports: true,
        cancellationRequests: {
          orderBy: { createdAt: "desc" },
        },
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const completedServices = await prisma.completedService.findMany({
      where: {
        OR: [
          {
            seekerId: user.id,
            OR: [
              { bookingId: null },
              { booking: { hiddenBySeeker: false } },
            ],
          },
          {
            providerId: user.id,
            OR: [
              { bookingId: null },
              { booking: { hiddenByProvider: false } },
            ],
          },
        ],
      },
      include: {
        seeker: {
          select: { id: true, name: true, email: true, phone: true, avatarUrl: true },
        },
        provider: {
          select: { id: true, name: true, email: true, phone: true, avatarUrl: true, trustScore: true },
        },
        reviews: true,
        booking: {
          include: {
            service: { select: { title: true } },
            offer: { include: { request: { select: { title: true } } } },
            directRequest: { include: { service: { select: { title: true } } } },
          },
        },
      },
      orderBy: { completedAt: "desc" },
    });

    res.json({
      success: true,
      data: {
        bookings,
        completedServices,
      },
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
    const { hideBookingService } = await import("../../services/bookings.service");
    const result = await hideBookingService(id as string, user.id);
    res.json({ success: true, message: "Booking removed from your view.", data: result });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /bookings/direct/:id/respond ────────────────────────────────────────
