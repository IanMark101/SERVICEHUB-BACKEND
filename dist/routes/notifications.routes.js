"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const notifications_controller_1 = require("../controllers/notifications.controller");
const router = (0, express_1.Router)();
// All notification routes require authentication
router.use(auth_middleware_1.requireAuth);
// GET /notifications — list user's notifications
router.get("/", notifications_controller_1.getMyNotifications);
// PATCH /notifications/read-all — mark all notifications as read
router.patch("/read-all", notifications_controller_1.markAllAsRead);
exports.default = router;
//# sourceMappingURL=notifications.routes.js.map