import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import { lockAccountLifecycle } from "../services/account-lifecycle.service";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";

const appealSchema = z.object({ message: z.string().trim().min(20).max(2000) }).strict();

async function latestBanId(userId: string) {
  const logs = await prisma.adminAuditLog.findMany({
    where: { targetUserId: userId, action: "USER_BANNED" },
    select: { id: true }, orderBy: { createdAt: "desc" }, take: 1,
  });
  return logs[0]?.id ?? `legacy-ban:${userId}`;
}

export async function getMyBanAppeal(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    if (user.moderationStatus !== "BANNED") return res.status(403).json({ success: false, error: "This route is for banned accounts only" });
    const banAuditLogId = await latestBanId(user.id);
    const appeal = await prisma.banAppeal.findUnique({ where: { banAuditLogId }, select: {
      id: true, message: true, status: true, decisionReason: true, createdAt: true, decidedAt: true,
    } });
    res.json({ success: true, data: { appeal } });
  } catch (error) { next(error); }
}

export async function submitBanAppeal(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;
    if (user.moderationStatus !== "BANNED") return res.status(403).json({ success: false, error: "This route is for banned accounts only" });
    const { message } = appealSchema.parse(req.body);
    const appeal = await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, user.id);
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { moderationStatus: true } });
      if (current.moderationStatus !== "BANNED") throw Object.assign(new Error("Account is no longer banned"), { status: 409 });
      const ban = await tx.adminAuditLog.findFirst({ where: { targetUserId: user.id, action: "USER_BANNED" }, select: { id: true }, orderBy: { createdAt: "desc" } });
      const banAuditLogId = ban?.id ?? `legacy-ban:${user.id}`;
      const existing = await tx.banAppeal.findUnique({ where: { banAuditLogId } });
      if (existing) throw Object.assign(new Error("An appeal has already been submitted for this ban"), { status: 409, code: "APPEAL_ALREADY_SUBMITTED" });
      const created = await tx.banAppeal.create({ data: { userId: user.id, banAuditLogId, message } });
      const admins = await tx.user.findMany({ where: { role: "admin", isActive: true, moderationStatus: "ACTIVE" }, select: { id: true } });
      if (admins.length) await tx.notification.createMany({ data: admins.map((admin) => ({ userId: admin.id, title: "New ban appeal", body: `${user.name} submitted a ban appeal for review.`, link: "/admin/ban-appeals" })) });
      return created;
    });
    safeEmit("admin", "notification", { title: "New ban appeal" });
    safeEmit('admin', 'ADMIN_MODERATION_CHANGED', { appealId: appeal.id });
    res.status(201).json({ success: true, data: { appeal: { id: appeal.id, status: appeal.status, createdAt: appeal.createdAt } } });
  } catch (error) { next(error); }
}
