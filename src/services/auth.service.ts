import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { sendVerificationEmail, sendPasswordResetEmail } from "../utils/email";
import type { RegisterInput, LoginInput } from "../schema/auth.schema";
import { recordAccountCreationBaseline } from "./trust.service";

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
    { sub: userId, jti: crypto.randomUUID() },
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
  facebookUrl?: string | null;
  instagramUrl?: string | null;
  websiteUrl?: string | null;
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

  // Record baseline trust score event in audit log
  await recordAccountCreationBaseline(user.id);

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
    const err = new Error("Please verify your email before logging in. Check your inbox for the verification link.") as any;
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

  // Rotate: delete old, issue new pair (deleteMany prevents P2025 on concurrent calls)
  const deleted = await prisma.refreshToken.deleteMany({ where: { token: incomingRefreshToken } });
  if (deleted.count === 0) {
    const err = new Error("Refresh token already used or revoked") as any;
    err.status = 401;
    throw err;
  }
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

export async function resendVerificationEmail(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return; // Silent return for privacy
  if (user.emailVerified) return; // Silent return if already verified

  // Rate Limiting: Check if a token was created in the last 60 seconds
  const existingToken = await prisma.emailVerificationToken.findFirst({
    where: { userId: user.id },
  });

  if (existingToken && Date.now() - existingToken.createdAt.getTime() < 60 * 1000) {
    const err = new Error("Please wait 60 seconds before requesting another verification email.") as any;
    err.status = 429;
    throw err;
  }

  // Delete existing verification tokens for this user
  await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });

  // Generate new token (24h expiry)
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.emailVerificationToken.create({
    data: { token, userId: user.id, expiresAt },
  });

  await sendVerificationEmail(user.email, user.name, token);
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
    facebookUrl: user.facebookUrl,
    instagramUrl: user.instagramUrl,
    websiteUrl: user.websiteUrl,
    role: user.role,
    trustScore: user.trustScore,
    verificationStatus: user.verificationStatus,
    emailVerified: user.emailVerified,
  };
}

export async function googleLoginUser(token: string): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  let email: string;
  let name: string;
  let avatarUrl: string | null = null;

  try {
    if (!env.GOOGLE_CLIENT_ID) {
      const error = new Error("Google sign-in is not configured") as any;
      error.status = 503;
      throw error;
    }
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      throw new Error("Token validation failed");
    }
    const data = (await response.json()) as any;
    if (!data.email) {
      throw new Error("Email field missing in Google profile");
    }

    // Require the exact configured OAuth client and a verified Google account.
    if (data.aud !== env.GOOGLE_CLIENT_ID ||
        !["accounts.google.com", "https://accounts.google.com"].includes(data.iss) ||
        data.email_verified !== "true" && data.email_verified !== true) {
    throw new Error("Google token claims are invalid");
    }

    email = data.email;
    name = data.name || email.split("@")[0];
    avatarUrl = data.picture || null;
  } catch (err: any) {
    const error = new Error(`Google sign-in failed: ${err.message}`) as any;
    // Preserve intentional service/configuration errors. Treat malformed or
    // unverifiable Google tokens as unauthorized.
    error.status = err.status ?? 401;
    throw error;
  }

  // 1. Check for existing user by email
  let user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    if (!user.isActive) {
      const err = new Error("Your account has been suspended. Please contact support.") as any;
      err.status = 403;
      throw err;
    }

    // Auto-verify email upon Google sign-in since Google already verified it
    if (!user.emailVerified) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    const tokens = await issueTokens(user.id, user.role);
    return { user: toPublicUser(user), tokens };
  } else {
    // 2. Auto-create new user from Google profile
    // Note: phone and location are null — the frontend must detect this and
    // prompt the user to complete their profile (Contact Info step) before
    // they can perform verified actions. This is intentional per Part 4.
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, SALT_ROUNDS);

    user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        phone: "",           // Will be collected during profile completion step
        location: "",        // Will be collected during profile completion step (barangay)
        avatarUrl,
        trustScore: 50,
        verificationStatus: "UNVERIFIED",
        emailVerified: true, // Auto-verified — Google already confirmed this email
        isActive: true,
        role: "user",        // Defaults to 'user', switchable to seeker/provider in frontend dashboard
      },
    });

    const tokens = await issueTokens(user.id, user.role);

    // Record baseline trust score event in audit log for new Google users
    await recordAccountCreationBaseline(user.id);

    return { user: toPublicUser(user), tokens };
  }
}

// ── Public & Edit Profile Services ───────────────────────────────────────────

export async function getUserPublicProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      location: true,
      avatarUrl: true,
      bio: true,
      facebookUrl: true,
      instagramUrl: true,
      websiteUrl: true,
      role: true,
      trustScore: true,
      verificationStatus: true,
      createdAt: true,
    },
  });

  if (!user) {
    const err = new Error("User not found") as any;
    err.status = 404;
    throw err;
  }

  // Get completed services count and reviews
  const completedCount = await prisma.completedService.count({
    where: { providerId: userId },
  });

  const reviews = await prisma.review.findMany({
    where: { targetId: userId },
    include: {
      author: {
        select: { id: true, name: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const avgRatingResult = await prisma.review.aggregate({
    where: { targetId: userId },
    _avg: { rating: true },
  });

  return {
    ...user,
    completedServiceCount: completedCount,
    averageRating: avgRatingResult._avg.rating ? Number(avgRatingResult._avg.rating.toFixed(1)) : 0,
    reviews: reviews.map(r => ({
      id: r.id,
      authorName: r.author.name,
      authorAvatar: r.author.avatarUrl,
      rating: r.rating,
      comment: r.text || '',
      createdAt: r.createdAt,
    })),
  };
}

export async function updateUserProfile(
  userId: string,
  data: {
    name?: string;
    bio?: string;
    phone?: string;
    location?: string;
    avatarUrl?: string;
    facebookUrl?: string;
    instagramUrl?: string;
    websiteUrl?: string;
    currentPassword?: string;
  }
) {
  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, phone: true, passwordHash: true },
  });

  if (!currentUser) {
    const err = new Error("User not found") as any;
    err.status = 404;
    throw err;
  }

  // Check if phone number is being updated
  const isPhoneChanging =
    data.phone !== undefined &&
    data.phone.trim() !== "" &&
    data.phone.trim() !== (currentUser.phone || "").trim();

  if (isPhoneChanging) {
    // 1. Active Job Lock: Check if user is a provider or seeker in any active/held booking
    const activeBookings = await prisma.booking.findMany({
      where: {
        OR: [{ providerId: userId }, { seekerId: userId }],
        status: {
          in: [
            "PENDING_APPROVAL",
            "WAITING",
            "ACCEPTED",
            "ONGOING",
            "AWAITING_CONFIRMATION",
            "UNDER_REVIEW",
            "DISPUTED",
          ],
        },
      },
      select: { id: true, status: true },
    });

    if (activeBookings.length > 0) {
      const err = new Error(
        "Mobile number cannot be changed while you have active service engagements in progress. Please complete or settle your active jobs first."
      ) as any;
      err.status = 400;
      throw err;
    }

    // 2. Password Re-Authentication: If passwordHash exists, verify currentPassword
    if (currentUser.passwordHash) {
      if (!data.currentPassword) {
        const err = new Error(
          "Current password is required to update your mobile/GCash payout number."
        ) as any;
        err.status = 400;
        throw err;
      }

      const isValidPassword = await bcrypt.compare(
        data.currentPassword,
        currentUser.passwordHash
      );
      if (!isValidPassword) {
        const err = new Error(
          "Incorrect current password. Mobile number was not updated."
        ) as any;
        err.status = 400;
        throw err;
      }
    }
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.bio !== undefined && { bio: data.bio }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.location !== undefined && { location: data.location }),
      ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
      ...(data.facebookUrl !== undefined && { facebookUrl: data.facebookUrl }),
      ...(data.instagramUrl !== undefined && { instagramUrl: data.instagramUrl }),
      ...(data.websiteUrl !== undefined && { websiteUrl: data.websiteUrl }),
    },
  });

  // 3. Security Notification on Phone Change
  if (isPhoneChanging) {
    try {
      await prisma.notification.create({
        data: {
          userId,
          title: "Security Alert: Mobile Number Updated 🔒",
          body: `Your mobile/GCash number was successfully updated to ${data.phone}. If you did not make this change, please contact support immediately.`,
          link: updatedUser.role === "provider" ? "/provider/account-settings" : "/seeker/account-settings",
        },
      });
    } catch (notifErr) {
      console.warn("Failed to create phone change security notification:", notifErr);
    }
  }

  return toPublicUser(updatedUser);
}

export async function changeUserPassword(
  userId: string,
  currentPassword?: string,
  newPassword?: string
) {
  if (!currentPassword || !newPassword) {
    const err = new Error("Current and new password are required") as any;
    err.status = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const err = new Error("User not found") as any;
    err.status = 404;
    throw err;
  }

  const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordValid) {
    const err = new Error("Current password is incorrect") as any;
    err.status = 400;
    throw err;
  }

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  });

  // A password change should invalidate every existing refresh session, not
  // only the browser that initiated it.
  await prisma.refreshToken.deleteMany({ where: { userId } });

  return { success: true };
}

