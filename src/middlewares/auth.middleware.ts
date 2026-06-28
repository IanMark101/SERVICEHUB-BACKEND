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
