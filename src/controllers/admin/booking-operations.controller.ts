import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { resolveAdminBooking } from "../../services/admin-booking-resolution.service";
import { BookingStatus, PaymentStatus, type Prisma } from "@prisma/client";

function pageParams(req: Request) {
  const page = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export async function listAdminBookings(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit, skip } = pageParams(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const needsResolution = req.query.needsResolution === "true";
    const where: Prisma.BookingWhereInput = {
      ...(status ? { status: status as never } : {}),
      AND: [
        ...(userId ? [{ OR: [{ seekerId: userId }, { providerId: userId }] }] : []),
        ...(needsResolution ? [{ OR: [
          { status: { in: [BookingStatus.PENDING_APPROVAL, BookingStatus.WAITING, BookingStatus.ACCEPTED, BookingStatus.ONGOING, BookingStatus.AWAITING_CONFIRMATION, BookingStatus.UNDER_REVIEW, BookingStatus.DISPUTED] } },
          { paymentStatus: { in: [PaymentStatus.PAID_HELD, PaymentStatus.FROZEN_HELD] } },
        ] }] : []),
      ],
    };
    const [items, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          originType: true,
          paymentMethod: true,
          agreedAmount: true,
          paymentStatus: true,
          status: true,
          statusBeforeDispute: true,
          started: true,
          createdAt: true,
          updatedAt: true,
          seeker: { select: { id: true, name: true, emailVerified: true, verificationStatus: true, moderationStatus: true } },
          provider: { select: { id: true, name: true, emailVerified: true, verificationStatus: true, moderationStatus: true } },
          service: { select: { id: true, title: true, status: true } },
          offer: { select: { id: true, request: { select: { id: true, title: true, status: true } } } },
          directRequest: { select: { id: true, status: true } },
          queue: { select: { id: true, status: true, position: true, paymentStatus: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);
    const operations = items.length ? await prisma.adminResolutionOperation.findMany({
      where: { caseType: "ADMIN_BOOKING", bookingId: { in: items.map((item) => item.id) } },
      select: { bookingId: true, requestedOutcome: true, status: true, stage: true, lastError: true },
    }) : [];
    const operationByBooking = new Map(operations.map((operation) => [operation.bookingId, operation]));
    res.json({ success: true, data: items.map((item) => ({ ...item, resolutionOperation: operationByBooking.get(item.id) || null })), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}

export async function listAdminPaymentAttempts(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit, skip } = pageParams(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const where = status ? { status: status as never } : {};
    const [attempts, total] = await Promise.all([
      prisma.paymentAttempt.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          seekerId: true,
          providerId: true,
          serviceId: true,
          offerId: true,
          providerIntentId: true,
          providerPaymentId: true,
          amount: true,
          currency: true,
          paymentMethod: true,
          status: true,
          failureReason: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.paymentAttempt.count({ where }),
    ]);
    const bookings = attempts.length > 0
      ? await prisma.booking.findMany({
          where: { paymentAttemptId: { in: attempts.map((attempt) => attempt.id) } },
          select: { id: true, paymentAttemptId: true, status: true, paymentStatus: true },
        })
      : [];
    const bookingByAttemptId = new Map(bookings.map((booking) => [booking.paymentAttemptId, booking]));
    const items = attempts.map((attempt) => ({
      ...attempt,
      booking: bookingByAttemptId.get(attempt.id) || null,
    }));
    res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}

export async function adminCancelUnstartedBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const bookingId = req.params.bookingId as string;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 2_000) {
      return res.status(400).json({ success: false, error: "A cancellation reason between 3 and 2000 characters is required" });
    }

    const adminId = (req as AuthenticatedRequest).user.id;
    const result = await resolveAdminBooking({ bookingId, adminId, outcome: "cancel_booking", reason, requireBannedParticipant: false });
    res.json({ success: true, data: result, message: "Booking cancelled and any held online payment submitted for refund" });
  } catch (error) {
    next(error);
  }
}

export async function resolveBannedParticipantBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const bookingId = req.params.bookingId as string;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const outcome = req.body?.outcome;
    if (reason.length < 3 || reason.length > 2_000) {
      return res.status(400).json({ success: false, error: "A decision reason between 3 and 2000 characters is required" });
    }
    if (outcome !== "cancel_booking" && outcome !== "release_provider_and_complete") {
      return res.status(400).json({ success: false, error: "Choose cancellation/refund or online payment release" });
    }
    const result = await resolveAdminBooking({
      bookingId,
      adminId: (req as AuthenticatedRequest).user.id,
      outcome,
      reason,
      requireBannedParticipant: true,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}
