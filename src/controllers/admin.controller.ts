import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";
import { adminReviewService, listPendingServices as adminListPendingServices } from "../services/services.service";
import { applyTrustEvent, applyReportPenaltyTrust, getTrustHistory } from "../services/trust.service";
import { safeEmit, safeBroadcast } from "../lib/socket";
import { BooleanDecisionSchema, ReportResolutionSchema, TrustAdjustmentSchema } from "../schema/marketplace.schema";

// ── GET /admin/overview ───────────────────────────────────────────────────────
export async function getOverview(_req: Request, res: Response, next: NextFunction) {
  try {
    const [totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions] = await Promise.all([
      prisma.user.count(),
      prisma.service.count({ where: { status: "ACTIVE" } }),
      prisma.serviceVerification.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.report.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
      prisma.service.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.categorySuggested.count({ where: { status: "PENDING" } }),
    ]);

    res.json({
      success: true,
      data: { totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/users ──────────────────────────────────────────────────────────
export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const { search, role, status, page = "1", limit = "10" } = req.query;
    const pageNum = Math.max(1, Math.min(10_000, parseInt(page as string, 10) || 1));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit as string, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: "insensitive" } },
        { email: { contains: search as string, mode: "insensitive" } },
      ];
    }

    if (role) {
      where.role = role as string;
    }

    if (status) {
      if (status === "active") {
        where.isActive = true;
      } else if (status === "suspended") {
        where.isActive = false;
      }
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true, role: true,
          trustScore: true, verificationStatus: true, emailVerified: true, isActive: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      }
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/trust ──────────────────────────────────────────────
export async function updateTrustScore(req: Request, res: Response, next: NextFunction) {
  try {
    const { delta: parsedDelta, reason } = TrustAdjustmentSchema.parse(req.body);
    await applyTrustEvent(req.params.id as string, parsedDelta, reason || "Admin manual override");
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/suspend ────────────────────────────────────────────
export async function suspendUser(req: Request, res: Response, next: NextFunction) {
  try {
    await prisma.user.update({ where: { id: req.params.id as string }, data: { isActive: false } });
    res.json({ success: true, message: "User suspended" });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/ban ────────────────────────────────────────────────
export async function banUser(req: Request, res: Response, next: NextFunction) {
  try {
    await prisma.user.update({ where: { id: req.params.id as string }, data: { isActive: false } });
    // Invalidate all sessions
    await prisma.refreshToken.deleteMany({ where: { userId: req.params.id as string } });
    res.json({ success: true, message: "User banned" });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/restore ────────────────────────────────────────────
export async function restoreUser(req: Request, res: Response, next: NextFunction) {
  try {
    await prisma.user.update({ where: { id: req.params.id as string }, data: { isActive: true } });
    res.json({ success: true, message: "User restored" });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/services/pending ───────────────────────────────────────────────
export async function listPendingServices(_req: Request, res: Response, next: NextFunction) {
  try {
    const services = await adminListPendingServices();
    res.json({ success: true, data: services });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/services/:id/review ──────────────────────────────────────────
export async function reviewService(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes } = BooleanDecisionSchema.parse(req.body);
    const result = await adminReviewService(req.params.id as string, (req as AuthenticatedRequest).user.id, approve, adminNotes);
    safeBroadcast("SERVICE_LISTING_APPROVED", { id: req.params.id, approved: approve });
    safeBroadcast("SERVICE_LISTINGS_CHANGED", { id: req.params.id, status: approve ? "ACTIVE" : "REJECTED" });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/categories/suggestions ─────────────────────────────────────────
export async function listCategorySuggestions(_req: Request, res: Response, next: NextFunction) {
  try {
    const suggestions = await prisma.categorySuggested.findMany({
      where: { status: "PENDING" },
      include: { submitter: { select: { id: true, name: true } } },
      orderBy: { submittedAt: "asc" },
    });
    res.json({ success: true, data: suggestions });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/categories/suggestions/:id ────────────────────────────────────
export async function resolveCategorySuggestion(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve } = BooleanDecisionSchema.parse(req.body);
    const suggestion = await prisma.categorySuggested.update({
      where: { id: req.params.id as string },
      data: { status: approve ? "APPROVED" : "REJECTED", reviewedAt: new Date() },
      include: { submitter: { select: { id: true, name: true } } },
    });

    if (approve) {
      // 1. Add to live categories list
      await prisma.category.create({
        data: { name: suggestion.name, isActive: true },
      });

      // 2. Part 18: Auto-post to Community Hub as a system announcement
      // Notify the submitter that their suggestion was approved
      await prisma.notification.create({
        data: {
          userId: suggestion.submitterId,
          title: `🎉 Category "${suggestion.name}" Approved!`,
          body: `Your suggested category "${suggestion.name}" has been added to the ServiceHub Cordova marketplace. Providers can now list services under this category.`,
          link: `/seeker/suggest-category`
        },
      });
      safeEmit(`user:${suggestion.submitterId}`, "notification", { title: `🎉 Category "${suggestion.name}" Approved!` });
    } else {
      // Notify submitter of rejection
      await prisma.notification.create({
        data: {
          userId: suggestion.submitterId,
          title: `Category Suggestion Not Approved`,
          body: `Your suggested category "${suggestion.name}" was not approved at this time. You may suggest a different category.`,
          link: `/seeker/suggest-category`
        },
      });
      safeEmit(`user:${suggestion.submitterId}`, "notification", { title: `Category Suggestion Not Approved` });
    }

    res.json({ success: true, data: suggestion });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/reports ────────────────────────────────────────────────────────
export async function listReports(_req: Request, res: Response, next: NextFunction) {
  try {
    const reports = await prisma.report.findMany({
      where: { status: { in: ["PENDING", "UNDER_REVIEW"] } },
      include: {
        reporter: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
        reportedUser: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
        booking: {
          include: {
            messages: { orderBy: { createdAt: "asc" }, take: 100 },
            queue: { select: { paymentStatus: true, joinedAt: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ success: true, data: reports });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/reports/:id/resolve ──────────────────────────────────────────
export async function resolveReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { action, adminNotes } = ReportResolutionSchema.parse(req.body);
    const report = await prisma.report.findUnique({
      where: { id: req.params.id as string },
      include: { booking: true, reporter: true, reportedUser: true },
    });

    if (!report) return res.status(404).json({ success: false, error: "Report not found" });

    await prisma.report.update({
      where: { id: req.params.id as string },
      data: {
        status: action === "dismiss" ? "DISMISSED" : "RESOLVED",
        adminId: (req as AuthenticatedRequest).user.id,
        adminNotes,
        resolvedAt: new Date(),
      },
    });

    // Execute the action (Spec Part 8: Warn, Reduce Trust, Suspend, Ban, Dismiss, Approve Refund)
    if (action === "warn") {
      // Just notify — no systemic penalty beyond the notification sent below
      const reportedRole = report.reportedUser?.role || "seeker";
      await prisma.notification.create({
        data: {
          userId: report.reportedUserId,
          title: "⚠️ Official Warning from Admin",
          body: `You have received a formal warning regarding a report. ${adminNotes || "Please review your behavior."}`,
          link: `/${reportedRole}/${reportedRole}-activity?tab=disputed&booking=${report.bookingId}`,
        },
      });
      safeEmit(`user:${report.reportedUserId}`, "notification", { title: "⚠️ Official Warning from Admin" });
    } else if (action === "trust_deduct") {
      await applyReportPenaltyTrust(report.reportedUserId);
    } else if (action === "suspend") {
      await prisma.user.update({ where: { id: report.reportedUserId }, data: { isActive: false } });
    } else if (action === "ban") {
      await prisma.user.update({ where: { id: report.reportedUserId }, data: { isActive: false } });
      // Invalidate all sessions immediately
      await prisma.refreshToken.deleteMany({ where: { userId: report.reportedUserId } });
      safeEmit(`user:${report.reportedUserId}`, "forceLogout", { reason: "Account permanently banned by administrator" });
    } else if (action === "approve_refund") {
      await prisma.booking.update({
        where: { id: report.bookingId },
        data: { paymentStatus: "REFUNDED", status: "CANCELED" },
      });
      await prisma.queue.updateMany({
        where: { bookingId: report.bookingId },
        data: { paymentStatus: "REFUNDED" },
      });
    } else if (action === "dismiss") {
      // Part 12: When admin dismisses a report, booking reverts to AWAITING_CONFIRMATION
      // so the seeker can still confirm or re-dispute. Without this, the booking
      // would be permanently stuck in DISPUTED/FROZEN_HELD with no exit path.
      if (report.bookingId) {
        const linkedBooking = await prisma.booking.findUnique({
          where: { id: report.bookingId },
          select: { status: true, paymentStatus: true },
        });
        // Only revert if it's in a disputed/frozen state — don't touch already-resolved bookings
        if (linkedBooking && (linkedBooking.status === "DISPUTED" || linkedBooking.status === "UNDER_REVIEW")) {
          await prisma.booking.update({
            where: { id: report.bookingId },
            data: {
              status: "AWAITING_CONFIRMATION",
              paymentStatus: "PAID_HELD",
            },
          });
          // Also unfreeze the Queue entry if one exists
          await prisma.queue.updateMany({
            where: { bookingId: report.bookingId },
            data: { paymentStatus: "PAID_HELD" },
          });
        }
      }
    }

    // Notify both parties
    const reporterRole = report.reporter?.role || "seeker";
    const reportedRole = report.reportedUser?.role || "seeker";
    await prisma.notification.createMany({
      data: [
        {
          userId: report.reporterId,
          title: "Report Resolved",
          body: `Your report has been reviewed and resolved. ${adminNotes || ""}`,
          link: `/${reporterRole}/${reporterRole}-activity?tab=all&booking=${report.bookingId}`,
        },
        {
          userId: report.reportedUserId,
          title: "Report Against You Resolved",
          body: `A report filed against you has been reviewed. ${adminNotes || ""}`,
          link: `/${reportedRole}/${reportedRole}-activity?tab=all&booking=${report.bookingId}`,
        },
      ],
    });
    safeEmit(`user:${report.reporterId}`, "notification", { title: "Report Resolved" });
    safeEmit(`user:${report.reportedUserId}`, "notification", { title: "Report Against You Resolved" });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/cancellation-requests/:id/resolve ─────────────────────────────
export async function resolveCancellationRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes: adminNote } = BooleanDecisionSchema.parse(req.body);
    const { adminResolveCancellationRequest } = await import("../services/cancellation.service");
    const result = await adminResolveCancellationRequest(req.params.id as string, approve, adminNote);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/cancellations/escalated ───────────────────────────────────────

export async function listEscalatedCancellations(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await prisma.cancellationRequest.findMany({
      where: { status: "ESCALATED" },
      include: {
        booking: {
          include: {
            seeker: { select: { id: true, name: true, email: true, trustScore: true } },
            provider: { select: { id: true, name: true, email: true, trustScore: true } },
            service: { select: { title: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
}

