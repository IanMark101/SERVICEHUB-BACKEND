import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";

// ── GET /notifications ────────────────────────────────────────────────────────
export async function getMyNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const page = Math.max(1, Number.parseInt(String(req.query?.page || "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query?.limit || "20"), 10) || 20));
    const where = { userId };
    const [notifications, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
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
    await prisma.notification.updateMany({
      where: { userId: (req as AuthenticatedRequest).user.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}
