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

    const [bookings, completedServices] = await Promise.all([
      prisma.booking.findMany({
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
          select: { id: true, title: true, description: true, price: true, priceType: true, estimatedDurationMins: true, category: { select: { name: true } } },
        },
        offer: {
          include: {
            request: {
              select: { title: true, targetServiceId: true, category: { select: { name: true } } },
            },
          },
        },
        directRequest: {
          select: {
            message: true,
            schedule: true,
            agreedPrice: true,
            quantity: true,
            service: {
              select: { title: true, category: { select: { name: true } }, estimatedDurationMins: true },
            },
          },
        },
        queue: true,
        reports: true,
        progressEvents: {
          select: { id: true, kind: true, actorRole: true, eventKey: true, occurredAt: true },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        },
        cancellationRequests: {
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      }),

      prisma.completedService.findMany({
      where: {
        // Linked Booking state is authoritative; canceled work is never completion history.
        AND: [{ OR: [{ bookingId: null }, { booking: { status: 'COMPLETED' } }] }],
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
          select: { id: true, name: true, email: true, phone: true, avatarUrl: true, trustScore: true },
        },
        provider: {
          select: { id: true, name: true, email: true, phone: true, avatarUrl: true, trustScore: true },
        },
        reviews: true,
        booking: {
          include: {
            progressEvents: {
              select: { id: true, kind: true, actorRole: true, eventKey: true, occurredAt: true },
              orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
            },
            service: { select: { title: true, category: { select: { name: true } }, estimatedDurationMins: true } },
            offer: { include: { request: { select: { title: true, targetServiceId: true, category: { select: { name: true } } } } } },
            directRequest: { include: { service: { select: { title: true, category: { select: { name: true } }, estimatedDurationMins: true } } } },
          },
        },
      },
      orderBy: { completedAt: "desc" },
      }),
    ]);

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
    const { hideBookingService } = await import("../../services/bookings.service.js");
    const result = await hideBookingService(id as string, user.id);
    res.json({ success: true, message: "Booking removed from your view.", data: result });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /bookings/direct/:id/respond ────────────────────────────────────────
