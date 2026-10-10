import type { RequestHandler } from "express";
import { ipKeyGenerator } from "express-rate-limit";

export interface CaptchaConfig {
  enabled: boolean;
  siteKey: string;
  secretKey: string;
  allowedHostnames: string[];
}

export class CaptchaError extends Error {
  constructor(public code: "CAPTCHA_REQUIRED" | "CAPTCHA_UNAVAILABLE", message: string) {
    super(message);
  }
}

/** Never trust the browser's checkbox state; Google consumes each token once. */
export async function verifyCaptcha(
  token: unknown,
  config: CaptchaConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  if (!config.enabled) return;
  if (typeof token !== "string" || token.trim().length < 20 || token.length > 4096) {
    throw new CaptchaError("CAPTCHA_REQUIRED", "Complete the ‘I'm not a robot’ check to continue.");
  }
  if (!config.secretKey || !config.siteKey || !config.allowedHostnames.length) {
    throw new CaptchaError("CAPTCHA_UNAVAILABLE", "Security verification is unavailable. Please try again later.");
  }
  let result: unknown;
  try {
    const response = await fetcher("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: config.secretKey, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Verification unavailable");
    result = await response.json();
  } catch {
    // Fail closed without leaking tokens, secrets, or provider error details.
    throw new CaptchaError("CAPTCHA_UNAVAILABLE", "Security verification could not connect. Please try again.");
  }
  const body = result as { success?: unknown; hostname?: unknown; challenge_ts?: unknown; "error-codes"?: unknown } | null;
  if (Array.isArray(body?.["error-codes"]) && body["error-codes"].some((code) => ["invalid-input-secret", "missing-input-secret"].includes(code))) {
    throw new CaptchaError("CAPTCHA_UNAVAILABLE", "Security verification is unavailable. Please try again later.");
  }
  const challengeTime = typeof body?.challenge_ts === "string" ? Date.parse(body.challenge_ts) : NaN;
  const age = now() - challengeTime;
  if (body?.success !== true || typeof body.hostname !== "string" || !config.allowedHostnames.includes(body.hostname.toLowerCase()) || !Number.isFinite(age) || age < -60_000 || age > 120_000) {
    throw new CaptchaError("CAPTCHA_REQUIRED", "Security verification expired or failed. Please complete the check again.");
  }
}

/** Single-process risk tracking; existing auth rate limits remain in force. */
export function createCaptchaProtection(
  config: CaptchaConfig,
  verify: (token: unknown) => Promise<void> = (token) => verifyCaptcha(token, config),
  now: () => number = Date.now,
  maxEntries = 10_000,
) {
  const failures = new Map<string, { count: number; expiresAt: number }>();
  const windowMs = 15 * 60_000;
  let capacityChallengeUntil = 0;
  const keyFor = (ip: string | undefined) => ipKeyGenerator(ip || "unknown");
  function required(ip: string | undefined) {
    const failure = failures.get(keyFor(ip));
    return config.enabled && (capacityChallengeUntil > now() || Boolean(failure && failure.expiresAt > now() && failure.count >= 3));
  }
  function recordFailure(ip: string | undefined) {
    const key = keyFor(ip);
    const current = failures.get(key);
    if (current && current.expiresAt > now()) {
      current.count = Math.min(3, current.count + 1);
      return;
    }
    // Bound memory without evicting an attacker's active challenge state.
    for (const [entryKey, value] of failures) if (value.expiresAt <= now()) failures.delete(entryKey);
    if (failures.size >= maxEntries) { capacityChallengeUntil = now() + windowMs; return; }
    failures.set(key, { count: 1, expiresAt: now() + windowMs });
  }

  const publicConfig: RequestHandler = (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: { enabled: config.enabled, siteKey: config.enabled ? config.siteKey : "", loginRequired: required(req.ip) } });
  };
  function guard(login: boolean): RequestHandler {
    return async (req, res, next) => {
      if (!config.enabled) { next(); return; }
      if (login) {
        res.once("finish", () => {
          if (res.statusCode === 401) recordFailure(req.ip);
          else if (res.statusCode >= 200 && res.statusCode < 300) failures.delete(keyFor(req.ip));
        });
      }
      if (!login || required(req.ip)) {
        try { await verify(req.body?.captchaToken); }
        catch (error) {
          if (!(error instanceof CaptchaError)) { next(error); return; }
          res.status(error.code === "CAPTCHA_UNAVAILABLE" ? 503 : 403).json({
            success: false, code: error.code, error: error.message, captchaRequired: true,
          });
          return;
        }
      }
      next();
    };
  }
  return { publicConfig, requireCaptcha: guard(false), passwordLoginCaptcha: guard(true) };
}
