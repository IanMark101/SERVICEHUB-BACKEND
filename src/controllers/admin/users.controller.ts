import type { Request, Response, NextFunction } from "express";
import type { Prisma } from "@prisma/client";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { applyManualTrustAdjustment } from "../../services/trust.service";
import { disconnectUserSockets, safeEmit } from "../../lib/socket";
import { BanUserSchema, RestoreUserSchema, SuspendUserSchema, TrustAdjustmentSchema } from "../../schema/marketplace.schema";
import bcrypt from "bcryptjs";
import { lockAccountLifecycle } from "../../services/account-lifecycle.service";

async function assertCanModerateUser(tx: Prisma.TransactionClient, adminId: string, targetId: string, allowAdminRestore = false) {
  if (adminId === targetId) {
    const error = new Error("Administrators cannot moderate their own account") as Error & { status?: number };
    error.status = 409;
    throw error;
  }
  const target = await tx.user.findUnique({ where: { id: targetId }, select: { role: true, deactivatedAt: true } });
  if (!target) {
    const error = new Error("User not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  if (target.deactivatedAt) throw Object.assign(new Error("A deleted account cannot be moderated or restored."), { status: 409 });
  if (target.role === "admin" && !allowAdminRestore) {
    const error = new Error("Administrator accounts cannot be suspended or banned from this moderation screen") as Error & { status?: number };
    error.status = 409;
    throw error;
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
    const { delta: parsedDelta, reason, currentPassword, operationId } = TrustAdjustmentSchema.parse(req.body);
    const adminId = (req as AuthenticatedRequest).user.id;
    const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { passwordHash: true, role: true, isActive: true, moderationStatus: true } });
    if (!admin || admin.role !== "admin" || !admin.isActive || admin.moderationStatus !== "ACTIVE" ||
      !(await bcrypt.compare(currentPassword, admin.passwordHash))) {
      return res.status(403).json({ success: false, error: "Current administrator password is incorrect" });
    }
    const result = await applyManualTrustAdjustment({ userId: req.params.id as string, adminId, delta: parsedDelta, reason, operationId });
    if (result.applied) safeEmit(`user:${req.params.id as string}`, "notification", { title: "Trust score adjusted" });
    res.json({ success: true, applied: result.applied });
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
    const suspendedUntil = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, targetId);
      await assertCanModerateUser(tx, adminId, targetId);
      const current = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { moderationStatus: true } });
      if (current.moderationStatus !== "ACTIVE") throw Object.assign(new Error("Only an active account can be suspended"), { status: 409 });
      await tx.user.update({
        where: { id: targetId },
        data: { isActive: true, moderationStatus: "SUSPENDED", suspendedUntil, moderationReason: reason },
      });
      await tx.notification.create({ data: { userId: targetId, title: "Account suspended", body: `Your account has been suspended until ${suspendedUntil.toLocaleDateString("en-PH")}. Reason: ${reason}` } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_SUSPENDED", resourceType: "User", resourceId: targetId, reason, metadata: { durationDays, suspendedUntil: suspendedUntil.toISOString() } },
      });
    });
    safeEmit(`user:${targetId}`, "notification", { title: "Account suspended" });
    safeEmit(`user:${targetId}`, "accountStatusChanged", { status: "SUSPENDED" });
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
    await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, targetId);
      await assertCanModerateUser(tx, adminId, targetId);
      const current = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { moderationStatus: true } });
      if (current.moderationStatus === "BANNED") {
        const error = new Error("Account is already banned") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      await tx.user.update({ where: { id: targetId }, data: { isActive: true, moderationStatus: "BANNED", suspendedUntil: null, moderationReason: reason } });
      await tx.notification.create({ data: { userId: targetId, title: "Account banned", body: "Your ServiceHub account has been banned. You may submit an appeal from the account notice.", link: "/account-banned" } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_BANNED", resourceType: "User", resourceId: targetId, reason, metadata: { obligationsReviewRequired: true } },
      });
    });
    await disconnectUserSockets(targetId, "Your ServiceHub account has been banned by an administrator.", "ACCOUNT_BANNED");
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
    await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, targetId);
      await assertCanModerateUser(tx, adminId, targetId, true);
      const current = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { moderationStatus: true, isActive: true } });
      if (current.moderationStatus === "ACTIVE" && current.isActive) {
        const error = new Error("Account is already active") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      await tx.user.update({ where: { id: targetId }, data: { isActive: true, moderationStatus: "ACTIVE", suspendedUntil: null, moderationReason: null } });
      const pendingAppeals = await tx.banAppeal.findMany({ where: { userId: targetId, status: "PENDING" }, select: { id: true } });
      await tx.banAppeal.updateMany({ where: { userId: targetId, status: "PENDING" }, data: { status: "APPROVED", decisionReason: reason, decidedById: adminId, decidedAt: new Date() } });
      for (const appeal of pendingAppeals) await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: targetId, action: "BAN_APPEAL_APPROVED", resourceType: "BanAppeal", resourceId: appeal.id, reason, metadata: { resolution: "MANUAL_RESTORE" } } });
      await tx.notification.create({ data: { userId: targetId, title: "Account restored", body: "Your ServiceHub account has been restored. Normal verification requirements still apply.", link: "/login" } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "USER_RESTORED", resourceType: "User", resourceId: targetId, reason },
      });
    });
    safeEmit(`user:${targetId}`, "accountStatusChanged", { status: "ACTIVE" });
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
    await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, targetId);
      await assertCanModerateUser(tx, adminId, targetId, true);
      await tx.user.update({
        where: { id: targetId },
        data: { postingSuspended: false, postingSuspendedAt: null, postingSuspendReason: null },
      });
      await tx.notification.create({ data: { userId: targetId, title: "Listing access restored", body: "An administrator restored your service-listing privilege. Other account and verification requirements still apply." } });
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: targetId, action: "POSTING_PRIVILEGE_RESTORED", resourceType: "User", resourceId: targetId, reason },
      });
    });
    safeEmit(`user:${targetId}`, "notification", { title: "Listing access restored" });
    res.json({ success: true, message: "Service-listing privilege restored" });
  } catch (error) {
    next(error);
  }
}

