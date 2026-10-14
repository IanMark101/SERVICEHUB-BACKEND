import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";
import { safeEmit } from '../lib/socket';

// ── GET /notifications ────────────────────────────────────────────────────────
export async function getMyNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const page = Math.max(1, Number.parseInt(String(req.query?.page || "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query?.limit || "20"), 10) || 20));
    const where = { userId };
    const [notifications, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, isRead: false } }),
    ]);
    res.json({ success: true, data: notifications, pagination: { page, limit, total, totalPages: Math.ceil(total / limit), unread } });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /notifications/read-all ─────────────────────────────────────────────
export async function markAllAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const readBefore = new Date();
    const unread = await prisma.$transaction(async tx => {
      await tx.notification.updateMany({ where: { userId, isRead: false, createdAt: { lte: readBefore } }, data: { isRead: true } });
      return tx.notification.count({ where: { userId, isRead: false } });
    });
    const receipt = { userId, unread, readBefore: readBefore.toISOString() };
    safeEmit(`user:${userId}`, 'notifications_read', receipt);
    res.json({ success: true, data: receipt });
  } catch (err) {
    next(err);
  }
}

// Reading one alert must not dismiss all of the member's other unread alerts.
export async function markOneAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const result = await prisma.$transaction(async tx => {
      const changed = await tx.notification.updateMany({ where: { id: req.params.id as string, userId }, data: { isRead: true } });
      if (!changed.count) return null;
      return { unread: await tx.notification.count({ where: { userId, isRead: false } }) };
    });
    if (!result) { res.status(404).json({ success: false, error: 'Notification not found' }); return; }
    const receipt = { ...result, userId, notificationId: req.params.id as string };
    safeEmit(`user:${userId}`, 'notifications_read', receipt);
    res.json({ success: true, data: receipt });
  } catch (error) { next(error); }
}
