import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  getMyNotifications,
  markAllAsRead,
  markOneAsRead,
} from "../controllers/notifications.controller";

const router = Router();

// All notification routes require authentication
router.use(requireAuth);

// GET /notifications — list user's notifications
router.get("/", getMyNotifications);

// PATCH /notifications/read-all — mark all notifications as read
router.patch("/read-all", markAllAsRead);
router.patch('/:id/read', markOneAsRead);

export default router;
