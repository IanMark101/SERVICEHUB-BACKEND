"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMyNotifications = getMyNotifications;
exports.markAllAsRead = markAllAsRead;
const prisma_1 = require("../lib/prisma");
// ── GET /notifications ────────────────────────────────────────────────────────
async function getMyNotifications(req, res, next) {
    try {
        const notifications = await prisma_1.prisma.notification.findMany({
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
async function markAllAsRead(req, res, next) {
    try {
        await prisma_1.prisma.notification.updateMany({
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