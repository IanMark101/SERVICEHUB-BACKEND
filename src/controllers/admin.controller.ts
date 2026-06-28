import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";
import { adminReviewService, listPendingServices as adminListPendingServices } from "../services/services.service";
import { applyTrustEvent } from "../services/trust.service";

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
    const { search } = req.query;
    const users = await prisma.user.findMany({
      where: search ? {
        OR: [
          { name: { contains: search as string, mode: "insensitive" } },
          { email: { contains: search as string, mode: "insensitive" } },
        ],
      } : undefined,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        trustScore: true, verificationStatus: true, emailVerified: true, isActive: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/trust ──────────────────────────────────────────────
export async function updateTrustScore(req: Request, res: Response, next: NextFunction) {
  try {
    const { delta, reason } = req.body;
    await applyTrustEvent(req.params.id as string, parseInt(delta), reason || "Admin manual override");
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
    const { approve, adminNotes } = req.body;
    const result = await adminReviewService(req.params.id as string, (req as AuthenticatedRequest).user.id, approve, adminNotes);
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
    const { approve } = req.body;
    const suggestion = await prisma.categorySuggested.update({
      where: { id: req.params.id as string },
      data: { status: approve ? "APPROVED" : "REJECTED", reviewedAt: new Date() },
    });

    if (approve) {
      // Add to live categories
      await prisma.category.create({
        data: { name: suggestion.name, isActive: true },
      });
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
    const { action, adminNotes } = req.body;
    const report = await prisma.report.findUnique({
      where: { id: req.params.id as string },
      include: { booking: true },
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

    // Execute the action
    if (action === "trust_deduct") {
      await applyTrustEvent(report.reportedUserId, -10, `Admin action on report ${report.id}`);
    } else if (action === "suspend") {
      await prisma.user.update({ where: { id: report.reportedUserId }, data: { isActive: false } });
    } else if (action === "approve_refund") {
      await prisma.booking.update({
        where: { id: report.bookingId },
        data: { paymentStatus: "REFUNDED", status: "CANCELED" },
      });
      await prisma.queue.updateMany({
        where: { bookingId: report.bookingId },
        data: { paymentStatus: "REFUNDED" },
      });
    }

    // Notify both parties
    await prisma.notification.createMany({
      data: [
        {
          userId: report.reporterId,
          title: "Report Resolved",
          body: `Your report has been reviewed and resolved. ${adminNotes || ""}`,
        },
        {
          userId: report.reportedUserId,
          title: "Report Against You Resolved",
          body: `A report filed against you has been reviewed. ${adminNotes || ""}`,
        },
      ],
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/cancellation-requests/:id/resolve ─────────────────────────────
export async function resolveCancellationRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNote } = req.body;
    if (typeof approve !== "boolean") {
      return res.status(400).json({ success: false, error: "approve must be a boolean" });
    }
    const { adminResolveCancellationRequest } = await import("../services/cancellation.service");
    const result = await adminResolveCancellationRequest(req.params.id as string, approve, adminNote);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
