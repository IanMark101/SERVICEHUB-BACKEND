import { prisma } from "../lib/prisma";
// ── GET /notifications ────────────────────────────────────────────────────────
export async function getMyNotifications(req, res, next) {
    try {
        const notifications = await prisma.notification.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: "desc" },
            take: 50,
        });
        res.json({ success: true, data: notifications });
    }
    catch (err) {
        next(err);
    }
}
// ── PATCH /notifications/read-all ─────────────────────────────────────────────
export async function markAllAsRead(req, res, next) {
    try {
        await prisma.notification.updateMany({
            where: { userId: req.user.id, isRead: false },
            data: { isRead: true },
        });
        res.json({ success: true });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=notifications.controller.js.map