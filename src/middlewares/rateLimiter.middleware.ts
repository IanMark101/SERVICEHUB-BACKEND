import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env";
import type { AuthenticatedRequest } from "./auth.middleware";

const isDev = env.NODE_ENV !== "production";

// ── Auth Limiter (Protects against brute-force password guessing) ─────────────
// In production: 30 attempts per 15 min; successful logins are skipped so valid users are never locked out.
// In development: generous 200 attempts per 15 min or localhost skip.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 200 : 30, // limit each IP to 30 requests in prod, 200 in dev
  skipSuccessfulRequests: true, // IMPORTANT: only count failed attempts against the rate limit
  skip: (req) => isDev && (req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1"),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many failed login attempts from this IP. Please try again after 15 minutes.",
  },
});

// ── General API Limiter (Generous: 1500 requests per 15 minutes per IP) ───────
// Protects general routes from runaway scraping or malicious loops while allowing fast client SPA navigation
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 5000 : 1500, // 1500 requests per 15 minutes
  skip: (req) => isDev && (req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1"),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please slow down and try again shortly.",
  },
});

// ── AI Endpoints Limiter (Moderate: 60 requests per minute per IP) ───────────
// Protects Gemini API quota from excessive calls
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isDev ? 120 : 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "AI generation rate limit exceeded. Please wait a moment before trying again.",
  },
});

// Cloud media uploads consume storage and transformation quota. Keep this
// intentionally narrower than the general API limiter.
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 60 : 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many upload attempts. Please try again later.",
  },
});

// The payment webhook is mounted before the general JSON middleware so its
// signature can be checked against the original bytes. It needs its own abuse
// boundary because it does not pass through the general API limiter.
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 300 : 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many webhook requests. Please retry shortly.",
  },
});

// Limits high-impact administrator mutations per authenticated account. This
// is applied after requireAuth, so shared municipal/admin-office IP addresses
// do not cause unrelated administrators to throttle one another.
export const adminMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 300 : 100,
  keyGenerator: (req) => {
    const userId = (req as AuthenticatedRequest).user?.id;
    if (userId) return `admin:${userId}`;

    const requestIp = req.ip;
    return requestIp ? `ip:${ipKeyGenerator(requestIp)}` : "ip:unknown";
  },
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many administrator changes. Please pause and try again shortly.",
  },
});
