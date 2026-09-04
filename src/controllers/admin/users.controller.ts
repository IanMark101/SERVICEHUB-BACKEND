import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { applyTrustEvent } from "../../services/trust.service";
import { disconnectUserSockets } from "../../lib/socket";
import { BanUserSchema, PromoteUserSchema, RestoreUserSchema, SuspendUserSchema, TrustAdjustmentSchema } from "../../schema/marketplace.schema";

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
  if (!allowAdminRestore) {
    const unstartedProviderBookings = await prisma.booking.count({
      where: {
        providerId: targetId,
        started: false,
        status: { in: ["PENDING_APPROVAL", "WAITING", "ACCEPTED"] },
      },
    });
    if (unstartedProviderBookings > 0) {
      const error = new Error(
        `Resolve or administratively cancel the provider's ${unstartedProviderBookings} unstarted booking(s) before suspension or banning`,
      ) as Error & { status?: number; code?: string };
      error.status = 409;
      error.code = "UNSTARTED_BOOKINGS_REQUIRE_RECONCILIATION";
      throw error;
    }
  }
}

// ── Community Hub announcements (official admin content only) ───────────────

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
        data: { isActive: true, moderationStatus: "SUSPENDED", suspendedUntil, moderationReason: reason },
      });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_SUSPENDED", resourceType: "User", resourceId: targetId, reason, metadata: { durationDays, suspendedUntil: suspendedUntil.toISOString() } },
      });
    });
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
      await tx.user.update({ where: { id: targetId }, data: { isActive: true, moderationStatus: "BANNED", suspendedUntil: null, moderationReason: reason } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_BANNED", resourceType: "User", resourceId: targetId, reason },
      });
    });
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
