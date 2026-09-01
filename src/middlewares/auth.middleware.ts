import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { getUserPermissions } from "../utils/permissions";

export interface AuthenticatedRequest extends Request {
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
    isActive: boolean;
    moderationStatus: string;
    suspendedUntil?: Date | null;
    postingSuspended: boolean;
  };
}

// ── requireAuth ───────────────────────────────────────────────────────────────
// Validates Bearer JWT, attaches full user object to req.user

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Authentication required" });
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
        isActive: true,
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

    if (!user.isActive || user.moderationStatus !== "ACTIVE") {
      return res.status(403).json({ success: false, error: "Account suspended" });
    }

    if (!user.emailVerified && !(req.baseUrl === "/api/auth" && req.path === "/me")) {
      return res.status(403).json({
        success: false,
        error: "Please verify your email address first",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    (req as AuthenticatedRequest).user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
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

  const permissions = getUserPermissions(user);
  if (!permissions.canTransact) {
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
        isActive: true,
        moderationStatus: true,
        suspendedUntil: true,
        postingSuspended: true,
      },
    });

    if (user && user.isActive && user.moderationStatus === "ACTIVE") {
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
