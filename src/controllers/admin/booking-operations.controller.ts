import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { performImmediateCancel } from "../../services/cancellation.service";

function pageParams(req: Request) {
  const page = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export async function listAdminBookings(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit, skip } = pageParams(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const where = status ? { status: status as never } : {};
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
    res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}

export async function listAdminPaymentAttempts(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit, skip } = pageParams(req);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const where = status ? { status: status as never } : {};
    const [items, total] = await Promise.all([
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
          booking: { select: { id: true, status: true, paymentStatus: true } },
        },
      }),
      prisma.paymentAttempt.count({ where }),
    ]);
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

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, providerId: true, started: true, status: true },
    });
    if (!booking) return res.status(404).json({ success: false, error: "Booking not found" });
    if (booking.started || !["PENDING_APPROVAL", "WAITING", "ACCEPTED"].includes(booking.status)) {
      return res.status(409).json({ success: false, error: "Only an unstarted nonterminal booking can be administratively cancelled here" });
    }

    const adminId = (req as AuthenticatedRequest).user.id;
    await performImmediateCancel(booking.id, adminId);
    await prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        targetUserId: booking.providerId,
        action: "ADMIN_UNSTARTED_BOOKING_CANCELLED",
        resourceType: "Booking",
        resourceId: booking.id,
        reason,
      },
    });
    res.json({ success: true, message: "Booking cancelled and any held online payment submitted for refund" });
  } catch (error) {
    next(error);
  }
}
