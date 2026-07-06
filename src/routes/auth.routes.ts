import { Router } from "express";
import {
  register,
  login,
  googleLogin,
  refresh,
  logout,
  verifyEmailHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  getMe,
  resendVerificationHandler,
} from "../controllers/auth.controller";
import { requireAuth } from "../middlewares/auth.middleware";

const router = Router();

// Public routes
router.post("/register", register);
router.post("/login", login);
router.post("/google-login", googleLogin);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/verify-email/:token", verifyEmailHandler);
router.post("/forgot-password", forgotPasswordHandler);
router.post("/reset-password", resetPasswordHandler);
router.post("/resend-verification", resendVerificationHandler);

// Protected routes
router.get("/me", requireAuth, getMe);

export default router;
