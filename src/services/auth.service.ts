import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { sendVerificationEmail, sendPasswordResetEmail } from "../utils/email";
import type { RegisterInput, LoginInput } from "../schema/auth.schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SALT_ROUNDS = 12;

function generateSecureToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function signAccessToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN as any }
  );
}

function signRefreshToken(userId: string): string {
  return jwt.sign(
    { sub: userId },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN as any }
  );
}

function refreshTokenExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 7); // 7 days
  return d;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  avatarUrl: string | null;
  bio: string | null;
  role: string;
  trustScore: number;
  verificationStatus: string;
  emailVerified: boolean;
}

// ── Register ──────────────────────────────────────────────────────────────────

export async function registerUser(input: RegisterInput): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  // Check for duplicate email
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    const err = new Error("An account with this email already exists") as any;
    err.status = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      phone: input.phone,
      location: input.location,
      bio: input.bio,
      avatarUrl: input.avatarUrl,
      trustScore: 50, // default Average band
      verificationStatus: "UNVERIFIED",
      emailVerified: false,
      isActive: true,
      role: "user",
    },
  });

  // Create email verification token (24h expiry)
  const verifyToken = generateSecureToken();
  const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.emailVerificationToken.create({
    data: { token: verifyToken, userId: user.id, expiresAt: verifyExpiry },
  });

  // Send verification email (logs to console in dev)
  await sendVerificationEmail(user.email, user.name, verifyToken);

  // Issue JWT tokens
  const tokens = await issueTokens(user.id, user.role);

  return { user: toPublicUser(user), tokens };
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function loginUser(input: LoginInput): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Generic error — never reveal whether email exists (master prompt rule)
  const invalidErr = new Error("Invalid credentials") as any;
  invalidErr.status = 401;

  if (!user) throw invalidErr;

  const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordValid) throw invalidErr;

  if (!user.isActive) {
    const err = new Error("Your account has been suspended. Please contact support.") as any;
    err.status = 403;
    throw err;
  }

  if (!user.emailVerified) {
    const err = new Error("Please verify your email address to unlock account access. Check your email for the verification link.") as any;
    err.status = 403;
    err.code = "EMAIL_UNVERIFIED";
    throw err;
  }

  const tokens = await issueTokens(user.id, user.role);
  return { user: toPublicUser(user), tokens };
}

// ── Refresh Token ─────────────────────────────────────────────────────────────

export async function refreshAccessToken(incomingRefreshToken: string): Promise<AuthTokens> {
  // Verify the token is signed correctly first
  let payload: any;
  try {
    payload = jwt.verify(incomingRefreshToken, env.JWT_REFRESH_SECRET);
  } catch {
    const err = new Error("Invalid or expired refresh token") as any;
    err.status = 401;
    throw err;
  }

  // Find it in DB (rotation: each token can only be used once)
  const stored = await prisma.refreshToken.findUnique({ where: { token: incomingRefreshToken } });
  if (!stored || stored.expiresAt < new Date()) {
    const err = new Error("Refresh token not found or expired") as any;
    err.status = 401;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user || !user.isActive) {
    const err = new Error("User not found or suspended") as any;
    err.status = 401;
    throw err;
  }

  // Rotate: delete old, issue new pair
  await prisma.refreshToken.delete({ where: { token: incomingRefreshToken } });
  return issueTokens(user.id, user.role);
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function logoutUser(refreshToken: string): Promise<void> {
  // Silently ignore if token not found (idempotent)
  await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
}

// ── Verify Email ──────────────────────────────────────────────────────────────

export async function verifyEmail(token: string): Promise<void> {
  const record = await prisma.emailVerificationToken.findUnique({ where: { token } });

  const invalidErr = new Error("Invalid or expired verification link") as any;
  invalidErr.status = 400;

  if (!record || record.expiresAt < new Date()) throw invalidErr;

  await prisma.user.update({
    where: { id: record.userId },
    data: { emailVerified: true },
  });

  await prisma.emailVerificationToken.delete({ where: { token } });
}

// ── Forgot Password ───────────────────────────────────────────────────────────

export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });

  // Always return success regardless of whether email exists (anti-enumeration)
  if (!user) return;

  // Invalidate any existing reset tokens for this user
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  await prisma.passwordResetToken.create({
    data: { token, userId: user.id, expiresAt },
  });

  await sendPasswordResetEmail(user.email, user.name, token);
}

// ── Reset Password ────────────────────────────────────────────────────────────

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({ where: { token } });

  const invalidErr = new Error("Invalid or expired reset link") as any;
  invalidErr.status = 400;

  if (!record || record.used || record.expiresAt < new Date()) throw invalidErr;

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  // Update password
  await prisma.user.update({
    where: { id: record.userId },
    data: { passwordHash },
  });

  // Invalidate reset token and all refresh tokens (all sessions)
  await prisma.passwordResetToken.update({ where: { token }, data: { used: true } });
  await prisma.refreshToken.deleteMany({ where: { userId: record.userId } });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function issueTokens(userId: string, role: string): Promise<AuthTokens> {
  const accessToken = signAccessToken(userId, role);
  const refreshToken = signRefreshToken(userId);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId,
      expiresAt: refreshTokenExpiresAt(),
    },
  });

  return { accessToken, refreshToken };
}

function toPublicUser(user: any): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    location: user.location,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    role: user.role,
    trustScore: user.trustScore,
    verificationStatus: user.verificationStatus,
    emailVerified: user.emailVerified,
  };
}
