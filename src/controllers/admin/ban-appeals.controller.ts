import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { safeEmit } from "../../lib/socket";
import { lockAccountLifecycle } from "../../services/account-lifecycle.service";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";

const decisionSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().trim().min(3).max(500) }).strict();
const listSchema = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(50).default(20),
  view: z.enum(['pending', 'history', 'all']).default('all'), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() });

export async function getBanAppealSummary(_req: Request, res: Response, next: NextFunction) {
  try {
    const pending = await prisma.banAppeal.count({ where: { status: 'PENDING' } });
    res.json({ success: true, data: { pending } });
  } catch (error) { next(error); }
}

export async function listBanAppeals(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit, status, view } = listSchema.parse(req.query);
    const where = { AND: [view === 'pending' ? { status: 'PENDING' } : view === 'history' ? { status: { in: ['APPROVED', 'REJECTED'] } } : {}, status ? { status } : {}] };
    const [appeals, total] = await Promise.all([
      prisma.banAppeal.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit,
        include: { user: { select: { id: true, name: true, email: true, moderationStatus: true, moderationReason: true } }, decidedBy: { select: { name: true } } } }),
      prisma.banAppeal.count({ where }),
    ]);
    const originalBans = await prisma.adminAuditLog.findMany({ where: { id: { in: appeals.map(appeal => appeal.banAuditLogId) }, action: 'USER_BANNED' }, select: { id: true, reason: true, createdAt: true } });
    const data = await Promise.all(appeals.map(async (appeal) => ({
      ...appeal,
      banAuditLog: originalBans.find(ban => ban.id === appeal.banAuditLogId) || null,
      moderationHistory: await prisma.adminAuditLog.findMany({ where: { targetUserId: appeal.userId, action: { not: 'USER_PROFILE_VIEWED' } }, select: { id: true, action: true, reason: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 8 }),
    })));
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
}

export async function decideBanAppeal(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = (req as AuthenticatedRequest).user.id;
    const appealId = req.params.id as string;
    const { decision, reason } = decisionSchema.parse(req.body);
    const appeal = await prisma.$transaction(async (tx) => {
      const initial = await tx.banAppeal.findUnique({ where: { id: appealId }, select: { userId: true } });
      if (!initial) throw Object.assign(new Error("Appeal not found"), { status: 404 });
      await lockAccountLifecycle(tx, initial.userId);
      const current = await tx.banAppeal.findUniqueOrThrow({ where: { id: appealId }, include: { user: { select: { moderationStatus: true } } } });
      if (current.status !== "PENDING" || current.user.moderationStatus !== "BANNED") throw Object.assign(new Error("Appeal is no longer pending for a banned account"), { status: 409 });
      const updated = await tx.banAppeal.update({ where: { id: appealId }, data: { status: decision, decisionReason: reason, decidedById: adminId, decidedAt: new Date() } });
      if (decision === "APPROVED") await tx.user.update({ where: { id: initial.userId }, data: { moderationStatus: "ACTIVE", isActive: true, suspendedUntil: null, moderationReason: null } });
      await tx.notification.create({ data: { userId: initial.userId, title: decision === "APPROVED" ? "Ban appeal approved" : "Ban appeal reviewed", body: decision === "APPROVED" ? "Your account has been restored. Normal verification requirements still apply." : "Your appeal was reviewed and your account remains banned. See the account notice for the decision.", link: decision === "APPROVED" ? "/login" : "/account-banned" } });
      await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: initial.userId, action: decision === "APPROVED" ? "BAN_APPEAL_APPROVED" : "BAN_APPEAL_REJECTED", resourceType: "BanAppeal", resourceId: appealId, reason } });
      return updated;
    });
    safeEmit(`user:${appeal.userId}`, "notification", { title: "Ban appeal reviewed" });
    safeEmit('admin', 'ADMIN_MODERATION_CHANGED', { appealId: appeal.id });
    res.json({ success: true, data: { appeal: { id: appeal.id, status: appeal.status, decidedAt: appeal.decidedAt } } });
  } catch (error) { next(error); }
}
