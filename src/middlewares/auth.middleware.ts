import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { getUserPermissions } from "../utils/permissions";

export interface AuthenticatedRequest extends Request {
  sessionId?: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    avatarUrl?: string | null;
    bio?: string | null;
    phone?: string | null;
    location?: string | null;
    facebookUrl?: string | null;
    instagramUrl?: string | null;
    websiteUrl?: string | null;
    trustScore: number;
    verificationStatus: string;
    emailVerified: boolean;
    onboardingStatus: "PENDING" | "COMPLETED" | "SKIPPED";
    isActive: boolean;
    deactivatedAt?: Date | null;
    moderationStatus: string;
    suspendedUntil?: Date | null;
    postingSuspended: boolean;
  };
}

export function accountAccessDecision(user: { isActive: boolean; moderationStatus: string; deactivatedAt?: Date | null }, allowBanned = false) {
  if (user.deactivatedAt) return "ACCOUNT_INACTIVE";
  if (user.moderationStatus === "BANNED") return allowBanned ? "ALLOW" : "ACCOUNT_BANNED";
  if (!user.isActive) return "ACCOUNT_INACTIVE";
  return "ALLOW";
}

// ── requireAuth ───────────────────────────────────────────────────────────────
// Validates Bearer JWT, attaches full user object to req.user

async function authenticate(req: Request, res: Response, next: NextFunction, allowBanned: boolean) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  const token = authHeader.split(" ")[1];

  let payload: { sub: string; role: string; sid?: string };
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { sub: string; role: string; sid?: string };
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
  if (!payload.sid) return res.status(401).json({ success: false, error: "Session expired" });
  try {
    const session = await prisma.refreshToken.findUnique({ where: { id: payload.sid }, select: { id: true, userId: true, expiresAt: true } });
    if (!session || session.userId !== payload.sub || session.expiresAt <= new Date()) {
      return res.status(401).json({ success: false, error: "Session expired" });
    }
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
        bio: true,
        phone: true,
        location: true,
        facebookUrl: true,
        instagramUrl: true,
        websiteUrl: true,
        trustScore: true,
        verificationStatus: true,
        emailVerified: true,
        onboardingStatus: true,
        isActive: true,
        deactivatedAt: true,
        moderationStatus: true,
        suspendedUntil: true,
        postingSuspended: true,
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }

    if (
      user.moderationStatus === "SUSPENDED" &&
      user.suspendedUntil &&
      user.suspendedUntil <= new Date()
    ) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          isActive: true,
          moderationStatus: "ACTIVE",
          suspendedUntil: null,
          moderationReason: null,
        },
      });
      user.isActive = true;
      user.moderationStatus = "ACTIVE";
      user.suspendedUntil = null;
    }

    const access = accountAccessDecision(user, allowBanned);
    if (access === "ACCOUNT_BANNED") return res.status(403).json({ success: false, code: "ACCOUNT_BANNED", error: "This account has been banned." });
    if (access === "ACCOUNT_INACTIVE") {
      if (user.moderationStatus === 'SUSPENDED') return res.status(403).json({ success: false, code: 'ACCOUNT_SUSPENDED', error: 'Your account is suspended. Marketplace transactions are unavailable until the suspension ends.' });
      return res.status(403).json({ success: false, error: "Account inactive" });
    }

    (req as AuthenticatedRequest).user = user;
    (req as AuthenticatedRequest).sessionId = session.id;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, false);
}

// Only /auth/me and the appeal endpoints may use this identity gate.
export function requireAccountIdentity(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, true);
}

// ── requireAdmin ──────────────────────────────────────────────────────────────
// Must be chained AFTER requireAuth

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthenticatedRequest).user;
  if (!user || user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Admin access required" });
  }
  next();
}

// ── requireMarketplaceUser ───────────────────────────────────────────────────
// Must be chained AFTER requireAuth. Blocks admins from standard user actions.

export function requireMarketplaceUser(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthenticatedRequest).user;
  if (!user || user.role === "admin") {
    return res.status(403).json({ success: false, error: "Marketplace action restricted to standard users" });
  }
  next();
}

// ── requireEmailVerified ──────────────────────────────────────────────────────
// Blocks access for unverified email users on sensitive endpoints

export function requireEmailVerified(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthenticatedRequest).user;
  if (!user.emailVerified) {
    return res.status(403).json({
      success: false,
      error: "Please verify your email address first",
      code: "EMAIL_NOT_VERIFIED",
    });
  }
  next();
}

// ── requireVerification ───────────────────────────────────────────────────────
// Part 6 — Residency verification gate. NEVER blocks login — only blocks
// specific ACTIONS: booking, posting requests, sending offers, creating listings.
// Must be chained AFTER requireAuth on those routes.
//
// UNVERIFIED / PENDING_REVIEW → 403 VERIFICATION_REQUIRED
// APPROVED                   → pass through

export function requireVerification(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthenticatedRequest).user;

  if (!user.emailVerified) {
    return res.status(403).json({
      success: false,
      error: "Please verify your email address first",
      code: "EMAIL_NOT_VERIFIED",
    });
  }

  const permissions = getUserPermissions(user);
  if (!permissions.canTransact) {
    if (user.moderationStatus === 'SUSPENDED' || user.moderationStatus === 'BANNED' || !user.isActive) {
      return res.status(403).json({ success: false, code: user.moderationStatus === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : user.moderationStatus === 'BANNED' ? 'ACCOUNT_BANNED' : 'ACCOUNT_INACTIVE', error: user.moderationStatus === 'SUSPENDED' ? 'Your account is suspended. Marketplace transactions are unavailable until the suspension ends.' : user.moderationStatus === 'BANNED' ? 'Your account is banned from marketplace transactions.' : 'Your account is inactive. Restore it before making marketplace transactions.' });
    }
    const isPending = user.verificationStatus === "PENDING_REVIEW";
    return res.status(403).json({
      success: false,
      error: isPending
        ? "Verification under review — usually within 24 hours. You cannot perform this action yet."
        : "Please verify your Cordova residency to perform this action.",
      code: "VERIFICATION_REQUIRED",
      verificationStatus: user.verificationStatus,
    });
  }
  next();
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { sub: string; role: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        trustScore: true,
        verificationStatus: true,
        emailVerified: true,
        onboardingStatus: true,
        isActive: true,
        moderationStatus: true,
        suspendedUntil: true,
        postingSuspended: true,
      },
    });

    if (user && user.isActive && user.moderationStatus !== "BANNED") {
      (req as AuthenticatedRequest).user = user;
    }
  } catch (err) {
    // Ignore invalid tokens for optional auth
  }
  next();
}

// Refresh tokens are cookie-authenticated. In production, require the browser
// request to originate from the configured frontend so another site cannot
// trigger refresh/logout actions with a cross-site cookie request.
export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction) {
  if (env.NODE_ENV !== "production") return next();

  const origin = req.get("origin");
  let trustedOrigin: string | undefined;
  try {
    trustedOrigin = new URL(env.FRONTEND_URL).origin;
  } catch {
    // A malformed deployment setting must fail closed rather than disable the
    // cross-site request protection for cookie-authenticated endpoints.
  }

  if (!origin || !trustedOrigin || origin !== trustedOrigin) {
    return res.status(403).json({ success: false, error: "Untrusted request origin" });
  }
  next();
}

export function requirePostingPrivilege(req: Request, res: Response, next: NextFunction) {
  const user = (req as AuthenticatedRequest).user;
  if (user.postingSuspended) {
    return res.status(403).json({
      success: false,
      error: "Your service-listing privilege is suspended pending administrator review",
      code: "POSTING_SUSPENDED",
    });
  }
  next();
}
