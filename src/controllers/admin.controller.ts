import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";
import { listPendingServices as adminListPendingServices } from "../services/services.service";
import { reviewServiceListing, resolveCategory } from "../services/admin-moderation.service";
import { listAdminReports, resolveAdminReport } from "../services/admin-report.service";
import { applyTrustEvent, applyReportPenaltyTrust, getTrustHistory } from "../services/trust.service";
import { safeEmit, safeBroadcast, disconnectUserSockets } from "../lib/socket";
import { AnnouncementCreateSchema, AnnouncementUpdateSchema, BanUserSchema, BooleanDecisionSchema, PromoteUserSchema, ReportResolutionSchema, RestoreUserSchema, SuspendUserSchema, TrustAdjustmentSchema } from "../schema/marketplace.schema";

// ── GET /admin/overview ───────────────────────────────────────────────────────
export async function getOverview(_req: Request, res: Response, next: NextFunction) {
  try {
    const [totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions, recentAuditLogs] = await Promise.all([
      prisma.user.count({ where: { role: { not: "admin" } } }),
      prisma.service.count({ where: { status: "ACTIVE", isAvailable: true, provider: { isActive: true } } }),
      prisma.serviceVerification.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.report.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
      prisma.service.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.categorySuggested.count({ where: { status: "PENDING" } }),
      prisma.adminAuditLog.findMany({
        include: { actor: { select: { id: true, name: true } }, targetUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

    res.json({
      success: true,
      data: { totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions, recentAuditLogs },
    });
  } catch (err) {
    next(err);
  }
}

async function assertCanModerateUser(adminId: string, targetId: string, allowAdminRestore = false) {
  if (adminId === targetId) {
    const error = new Error("Administrators cannot moderate their own account") as Error & { status?: number };
    error.status = 409;
    throw error;
  }
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true } });
  if (!target) {
    const error = new Error("User not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  if (target.role === "admin" && !allowAdminRestore) {
    const error = new Error("Administrator accounts cannot be suspended or banned from this moderation screen") as Error & { status?: number };
    error.status = 409;
    throw error;
  }
}

// ── Community Hub announcements (official admin content only) ───────────────

export async function listAnnouncements(_req: Request, res: Response, next: NextFunction) {
  try {
    const announcements = await prisma.announcement.findMany({
      include: { author: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ success: true, data: announcements });
  } catch (err) {
    next(err);
  }
}

export async function createAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const input = AnnouncementCreateSchema.parse(req.body);
    const announcement = await prisma.announcement.create({
      data: {
        title: input.title,
        body: input.body,
        authorId: admin.id,
        isPublished: input.isPublished,
        publishedAt: input.isPublished ? new Date() : null,
      },
      include: { author: { select: { id: true, name: true } } },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: "ANNOUNCEMENT_CREATED",
        resourceType: "Announcement",
        resourceId: announcement.id,
        reason: input.isPublished ? "Published official Community Hub announcement" : "Created announcement draft",
      },
    });
    safeBroadcast("COMMUNITY_ANNOUNCEMENTS_CHANGED", { id: announcement.id });
    res.status(201).json({ success: true, data: announcement });
  } catch (err) {
    next(err);
  }
}

export async function updateAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as AuthenticatedRequest).user;
    const input = AnnouncementUpdateSchema.parse(req.body);
    const existing = await prisma.announcement.findUnique({ where: { id: req.params.id as string } });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Announcement not found" });
    }

    const becomingPublished = input.isPublished === true && !existing.isPublished;
    const announcement = await prisma.announcement.update({
      where: { id: existing.id },
      data: {
        ...input,
        ...(becomingPublished && { publishedAt: new Date() }),
      },
      include: { author: { select: { id: true, name: true } } },
    });
    await prisma.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: "ANNOUNCEMENT_UPDATED",
        resourceType: "Announcement",
        resourceId: announcement.id,
        reason: input.isPublished === false ? "Archived announcement" : input.isPublished === true ? "Published announcement" : "Edited announcement content",
        metadata: input,
      },
    });
    safeBroadcast("COMMUNITY_ANNOUNCEMENTS_CHANGED", { id: announcement.id });
    res.json({ success: true, data: announcement });
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
        where.moderationStatus = "ACTIVE";
      } else if (status === "suspended") {
        where.moderationStatus = "SUSPENDED";
      } else if (status === "banned") {
        where.moderationStatus = "BANNED";
      }
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, name: true, email: true, phone: true, role: true,
          trustScore: true, verificationStatus: true, emailVerified: true, isActive: true,
          moderationStatus: true, suspendedUntil: true, moderationReason: true,
          postingSuspended: true, postingSuspendReason: true, createdAt: true,
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
    const adminId = (req as AuthenticatedRequest).user.id;
    await applyTrustEvent(req.params.id as string, parsedDelta, reason, adminId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/suspend ────────────────────────────────────────────
export async function suspendUser(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = (req as AuthenticatedRequest).user.id;
    const targetId = req.params.id as string;
    const { reason, durationDays } = SuspendUserSchema.parse(req.body);
    await assertCanModerateUser(adminId, targetId);
    const suspendedUntil = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetId },
        data: { isActive: false, moderationStatus: "SUSPENDED", suspendedUntil, moderationReason: reason },
      });
      await tx.refreshToken.deleteMany({ where: { userId: targetId } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_SUSPENDED", resourceType: "User", resourceId: targetId, reason, metadata: { durationDays, suspendedUntil: suspendedUntil.toISOString() } },
      });
    });
    await disconnectUserSockets(targetId, "Account temporarily suspended by an administrator");
    res.json({ success: true, message: "User suspended" });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/ban ────────────────────────────────────────────────
export async function banUser(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = (req as AuthenticatedRequest).user.id;
    const targetId = req.params.id as string;
    const { reason } = BanUserSchema.parse(req.body);
    await assertCanModerateUser(adminId, targetId);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: { isActive: false, moderationStatus: "BANNED", suspendedUntil: null, moderationReason: reason } });
      await tx.refreshToken.deleteMany({ where: { userId: targetId } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_BANNED", resourceType: "User", resourceId: targetId, reason },
      });
    });
    await disconnectUserSockets(targetId, "Account permanently banned by an administrator");
    res.json({ success: true, message: "User banned" });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/users/:id/restore ────────────────────────────────────────────
export async function restoreUser(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = (req as AuthenticatedRequest).user.id;
    const targetId = req.params.id as string;
    const { reason } = RestoreUserSchema.parse(req.body || {});
    await assertCanModerateUser(adminId, targetId, true);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: { isActive: true, moderationStatus: "ACTIVE", suspendedUntil: null, moderationReason: null } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_RESTORED", resourceType: "User", resourceId: targetId, reason },
      });
    });
    res.json({ success: true, message: "User restored" });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/services/pending ───────────────────────────────────────────────
export async function listPendingServices(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const result = await adminListPendingServices(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/services/:id/review ──────────────────────────────────────────
export async function reviewService(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes } = BooleanDecisionSchema.parse(req.body);
    const result = await reviewServiceListing(req.params.id as string, (req as AuthenticatedRequest).user.id, approve, adminNotes);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/categories/suggestions ─────────────────────────────────────────
export async function listCategorySuggestions(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const where = { status: "PENDING" as const };
    const [suggestions, total] = await Promise.all([
      prisma.categorySuggested.findMany({
        where,
        include: { submitter: { select: { id: true, name: true } } },
        orderBy: { submittedAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.categorySuggested.count({ where }),
    ]);
    res.json({
      success: true,
      data: suggestions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /admin/categories/suggestions/:id ────────────────────────────────────
async function resolveCategorySuggestionLegacy(req: Request, res: Response, next: NextFunction) {
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
export async function resolveCategorySuggestion(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes } = BooleanDecisionSchema.parse(req.body);
    const suggestion = await resolveCategory(
      req.params.id as string,
      (req as AuthenticatedRequest).user.id,
      approve,
      adminNotes,
    );
    res.json({ success: true, data: suggestion });
  } catch (error) {
    next(error);
  }
}

export async function restorePostingPrivilege(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = (req as AuthenticatedRequest).user.id;
    const targetId = req.params.id as string;
    const { reason } = RestoreUserSchema.parse(req.body || {});
    await assertCanModerateUser(adminId, targetId, true);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetId },
        data: { postingSuspended: false, postingSuspendedAt: null, postingSuspendReason: null },
      });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "POSTING_PRIVILEGE_RESTORED", resourceType: "User", resourceId: targetId, reason },
      });
    });
    res.json({ success: true, message: "Service-listing privilege restored" });
  } catch (error) {
    next(error);
  }
}

export async function promoteUserToAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const actorId = (req as AuthenticatedRequest).user.id;
    const targetId = req.params.id as string;
    const { reason } = PromoteUserSchema.parse(req.body);
    if (actorId === targetId) {
      return res.status(409).json({ success: false, error: "You are already an administrator" });
    }
    await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetId } });
      if (!target) {
        const error = new Error("User not found") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      if (!target.isActive || !target.emailVerified || target.moderationStatus !== "ACTIVE") {
        const error = new Error("Only an active, email-verified account can be promoted") as Error & { status?: number };
        error.status = 422;
        throw error;
      }
      if (target.role === "admin") {
        const error = new Error("User is already an administrator") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      await tx.user.update({ where: { id: targetId }, data: { role: "admin" } });
      await tx.refreshToken.deleteMany({ where: { userId: targetId } });
      await tx.adminAuditLog.create({
        data: { actorId, targetUserId: targetId, action: "USER_PROMOTED_TO_ADMIN", resourceType: "User", resourceId: targetId, reason },
      });
    });
    await disconnectUserSockets(targetId, "Account permissions changed. Please sign in again.");
    res.json({ success: true, message: "User promoted to administrator" });
  } catch (error) {
    next(error);
  }
}

async function listReportsLegacy(_req: Request, res: Response, next: NextFunction) {
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
async function resolveReportLegacy(req: Request, res: Response, next: NextFunction) {
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
export async function listReports(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(25, Number(req.query.limit) || 10));
    const result = await listAdminReports(page, limit);
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
}

export async function resolveReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { action, adminNotes } = ReportResolutionSchema.parse(req.body);
    const result = await resolveAdminReport(
      req.params.id as string,
      (req as AuthenticatedRequest).user.id,
      action,
      adminNotes,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function resolveCancellationRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes: adminNote } = BooleanDecisionSchema.parse(req.body);
    const { adminResolveCancellationRequest } = await import("../services/cancellation.service");
    const result = await adminResolveCancellationRequest(
      req.params.id as string,
      approve,
      adminNote,
      (req as AuthenticatedRequest).user.id,
    );
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

