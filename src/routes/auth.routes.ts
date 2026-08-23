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
  getPublicProfileHandler,
  updateProfileHandler,
  changePasswordHandler,
  getTrustHistoryHandler,
  getPublicTrustHistoryHandler,
} from "../controllers/auth.controller";
import { requireAuth } from "../middlewares/auth.middleware";
import { authLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

// Public routes (Rate-limited to 15 attempts per 15 minutes)
router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/google-login", authLimiter, googleLogin);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.get("/verify-email/:token", verifyEmailHandler);
router.post("/forgot-password", authLimiter, forgotPasswordHandler);
router.post("/reset-password", authLimiter, resetPasswordHandler);
router.post("/resend-verification", authLimiter, resendVerificationHandler);
router.get("/profile/:id", getPublicProfileHandler);

// Protected routes
router.get("/me", requireAuth, getMe);
router.put("/profile", requireAuth, updateProfileHandler);
router.post("/change-password", requireAuth, changePasswordHandler);
router.get("/trust-history", requireAuth, getTrustHistoryHandler);
router.get("/trust-history/:id", getPublicTrustHistoryHandler);

export default router;
