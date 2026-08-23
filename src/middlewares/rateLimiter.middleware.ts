import rateLimit from "express-rate-limit";

// ── Auth Limiter (Strict: 15 attempts per 15 minutes per IP) ─────────────────
// Protects against brute-force password guessing and registration spam
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 requests per windowMs
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many login/auth attempts from this IP. Please try again after 15 minutes.",
  },
});

// ── General API Limiter (Generous: 300 requests per 15 minutes per IP) ───────
// Protects general routes from scraping or runaway polling loops
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // limit each IP to 300 requests per windowMs
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please slow down and try again shortly.",
  },
});

// ── AI Endpoints Limiter (Moderate: 30 requests per minute per IP) ───────────
// Protects Gemini API quota from excessive calls
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "AI generation rate limit exceeded. Please wait a moment before trying again.",
  },
});
