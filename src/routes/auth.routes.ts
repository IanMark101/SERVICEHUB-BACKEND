import { Router } from "express";
import {
  register,
  login,
  refresh,
  logout,
  verifyEmailHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  getMe,
} from "../controllers/auth.controller";
import { requireAuth } from "../middlewares/auth.middleware";

const router = Router();

// Public routes
router.post("/register", register);
router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/verify-email/:token", verifyEmailHandler);
router.post("/forgot-password", forgotPasswordHandler);
router.post("/reset-password", resetPasswordHandler);

// Protected routes
router.get("/me", requireAuth, getMe);

export default router;
