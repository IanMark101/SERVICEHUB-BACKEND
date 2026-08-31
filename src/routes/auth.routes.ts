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
} from "../controllers/auth.controller";
import { requireAuth, requireTrustedOrigin } from "../middlewares/auth.middleware";
import { authLimiter } from "../middlewares/rateLimiter.middleware";

const router = Router();

// Public routes (Rate-limited to 15 attempts per 15 minutes)
router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/google-login", authLimiter, googleLogin);
router.post("/refresh", requireTrustedOrigin, refresh);
router.post("/logout", requireTrustedOrigin, logout);
router.get("/verify-email/:token", verifyEmailHandler);
router.post("/forgot-password", authLimiter, forgotPasswordHandler);
router.post("/reset-password", authLimiter, resetPasswordHandler);
router.post("/resend-verification", authLimiter, resendVerificationHandler);
router.get("/profile/:id", requireAuth, getPublicProfileHandler);

// Protected routes
router.get("/me", requireAuth, getMe);
router.put("/profile", requireAuth, updateProfileHandler);
router.post("/change-password", requireAuth, changePasswordHandler);
// GET /auth/trust-history — own account only; detailed event log is private.
router.get("/trust-history", requireAuth, getTrustHistoryHandler);
// GET /trust-history/:id removed — detailed event reasons are private to the
// account owner. Public profiles already expose the aggregate trustScore field.

export default router;
