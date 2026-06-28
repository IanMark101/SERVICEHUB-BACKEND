import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";

// ── GET /notifications ────────────────────────────────────────────────────────
export async function getMyNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: (req as AuthenticatedRequest).user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ success: true, data: notifications });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /notifications/read-all ─────────────────────────────────────────────
export async function markAllAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    await prisma.notification.updateMany({
      where: { userId: (req as AuthenticatedRequest).user.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
