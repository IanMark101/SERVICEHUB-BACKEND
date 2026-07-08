import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    trustScore: number;
    verificationStatus: string;
    emailVerified: boolean;
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
        trustScore: true,
        verificationStatus: true,
        emailVerified: true,
        isActive: true,
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }

    if (!user.isActive) {
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

  // Admins bypass this check — they have an elevated, non-switchable role
  if (user.role === "admin") return next();

  if (user.verificationStatus !== "APPROVED") {
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
      },
    });

    if (user && user.isActive) {
      (req as AuthenticatedRequest).user = user;
    }
  } catch (err) {
    // Ignore invalid tokens for optional auth
  }
  next();
}
