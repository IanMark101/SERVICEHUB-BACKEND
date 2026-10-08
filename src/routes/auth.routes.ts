import { Router } from "express";
import {
  register,
  login,
  googleLogin,
  refresh,
  session,
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
  getUserTrustHistoryHandler,
} from "../controllers/auth.controller";
import { requireAuth, requireAccountIdentity, requireTrustedOrigin } from "../middlewares/auth.middleware";
import { getMyBanAppeal, submitBanAppeal } from "../controllers/ban-appeals.controller";
import { authLimiter, passwordMutationLimiter } from "../middlewares/rateLimiter.middleware";
import { captchaConfig, requireCaptcha, passwordLoginCaptcha } from "../middlewares/captcha.middleware";
import { securityMethods, passwordSetupChallenge, passwordSetupVerification, setPassword } from "../controllers/password-management.controller";

const router = Router();

// Public routes (Rate-limited to 15 attempts per 15 minutes)
router.get("/captcha-config", captchaConfig);
router.post("/register", authLimiter, requireCaptcha, register);
router.post("/login", authLimiter, passwordLoginCaptcha, login);
router.post("/google-login", authLimiter, googleLogin);
router.post("/refresh", requireTrustedOrigin, refresh);
router.post("/session", requireTrustedOrigin, session);
router.post("/logout", requireTrustedOrigin, logout);
router.get("/verify-email/:token", verifyEmailHandler);
router.post("/forgot-password", authLimiter, requireCaptcha, forgotPasswordHandler);
router.post("/reset-password", authLimiter, resetPasswordHandler);
router.post("/resend-verification", authLimiter, resendVerificationHandler);
router.get("/profile/:id", requireAuth, getPublicProfileHandler);

// Protected routes
router.get("/me", requireAccountIdentity, getMe);
router.get("/ban-appeal", requireAccountIdentity, getMyBanAppeal);
router.post("/ban-appeal", requireAccountIdentity, authLimiter, submitBanAppeal);
router.put("/profile", requireAuth, updateProfileHandler);
router.get("/security", requireAuth, securityMethods);
router.post("/password-setup/challenge", requireAuth, passwordMutationLimiter, passwordSetupChallenge);
router.post("/password-setup/verify", requireAuth, passwordMutationLimiter, passwordSetupVerification);
router.post("/set-password", requireAuth, passwordMutationLimiter, setPassword);
router.post("/change-password", requireAuth, passwordMutationLimiter, changePasswordHandler);
router.get("/trust-history", requireAuth, getTrustHistoryHandler);
router.get("/trust-history/:id", requireAuth, getUserTrustHistoryHandler);

export default router;
