import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { sendVerificationEmail, sendPasswordResetEmail } from "../../utils/email";
import type { RegisterInput, LoginInput } from "../../schema/auth.schema";
import { disconnectSessionSockets, disconnectUserSockets } from "../../lib/socket";
import { lockAuthenticationSession } from "./session-lifecycle.service";
import { lockAccountLifecycle } from "../account-lifecycle.service";
import { signInMethods } from "./password-management.service";
import { StrongPasswordSchema } from "../../schema/password.schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

export const SALT_ROUNDS = 12;

function generateSecureToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signAccessToken(userId: string, role: string, sessionId: string): string {
  return jwt.sign(
    { sub: userId, role, sid: sessionId },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN as any }
  );
}

function signRefreshToken(userId: string, sessionId: string): string {
  return jwt.sign(
    { sub: userId, sid: sessionId, jti: crypto.randomUUID() },
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
  onboardingStatus: "PENDING" | "COMPLETED" | "SKIPPED";
  moderationStatus: string;
  signInMethods: ReturnType<typeof signInMethods>;
}

// ── Register ──────────────────────────────────────────────────────────────────

export async function registerUser(input: RegisterInput): Promise<{
  user: AuthUser;
  tokens: AuthTokens;
  verificationEmailSent: boolean;
}> {
  // Check for duplicate email
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    const err = new Error("An account with this email already exists") as any;
    err.status = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  // Create email verification token (24h expiry)
  const verifyToken = generateSecureToken();
  const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Keep the account, trust baseline, and verification token atomic. A
  // partial database failure must not leave a ghost account after the API
  // tells the user registration failed.
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        passwordState: "SET",
        phone: input.phone,
        location: input.location,
        bio: input.bio,
        avatarUrl: input.avatarUrl,
        trustScore: 50,
        verificationStatus: "UNVERIFIED",
        emailVerified: false,
        isActive: true,
        role: "user",
      },
    });
    await tx.trustScoreEvent.create({
      data: {
        userId: created.id,
        delta: 50,
        reason: "Initial Account Base Trust Score Baseline",
        scoreBefore: 0,
        scoreAfter: 50,
        eventKey: `account-baseline:${created.id}`,
      },
    });
    await tx.emailVerificationToken.create({
      data: { token: hashOpaqueToken(verifyToken), userId: created.id, expiresAt: verifyExpiry },
    });
    return created;
  });

  // Email delivery is external and cannot be part of the transaction. An
  // email-provider outage must not turn a durably created account into a
  // false registration failure; the user can request a fresh link.
  let verificationEmailSent = true;
  try {
    await sendVerificationEmail(user.email, user.name, verifyToken);
  } catch (error) {
    verificationEmailSent = false;
    console.error("Verification email delivery failed after account creation:", error);
  }

  // Issue JWT tokens
  const tokens = await issueTokens(user.id, user.passwordHash);

  return { user: toPublicUser(user), tokens, verificationEmailSent };
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function loginUser(input: LoginInput): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Generic error — never reveal whether email exists (master prompt rule)
  const invalidErr = new Error("Invalid credentials") as any;
  invalidErr.status = 401;

  if (!user) throw invalidErr;

  const passwordValid = user.passwordState !== "NONE" && await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordValid) throw invalidErr;

  if (user.deactivatedAt || (!user.isActive && user.moderationStatus !== "BANNED")) {
    const err = new Error("Your account has been suspended. Please contact support.") as any;
    err.status = 403;
    throw err;
  }

  const tokens = await issueTokens(user.id, user.passwordHash, true);
  return { user: toPublicUser({ ...user, passwordState: "SET", moderationStatus: tokens.moderationStatus }), tokens };
}

// ── Refresh Token ─────────────────────────────────────────────────────────────

async function resolveRefreshTokenUser(incomingRefreshToken: string) {
  try {
    jwt.verify(incomingRefreshToken, env.JWT_REFRESH_SECRET);
  } catch {
    const err = new Error("Invalid or expired refresh token") as any;
    err.status = 401;
    throw err;
  }

  // Find it in DB (rotation: each token can only be used once)
  const tokenHash = hashOpaqueToken(incomingRefreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { token: tokenHash } });
  if (!stored || stored.expiresAt < new Date()) {
    const err = new Error("Refresh token not found or expired") as any;
    err.status = 401;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user || user.deactivatedAt || (!user.isActive && user.moderationStatus !== "BANNED")) {
    const err = new Error("User not found or suspended") as any;
    err.status = 401;
    throw err;
  }

  return { tokenHash, user, sessionId: stored.id };
}

/**
 * Recover an access token without consuming the refresh token. This is used
 * only for initial page boot, where repeated browser reloads can abandon an
 * earlier response before its rotated cookie is committed.
 */
export async function recoverAccessToken(incomingRefreshToken: string): Promise<string> {
  return (await recoverSession(incomingRefreshToken)).accessToken;
}

/** The verified profile is already loaded for cookie validation. Returning it
 * avoids a second HTTP request and duplicate session/user database reads. */
export async function recoverSession(incomingRefreshToken: string): Promise<{ accessToken: string; user: AuthUser }> {
  const { user, sessionId } = await resolveRefreshTokenUser(incomingRefreshToken);
  return { accessToken: signAccessToken(user.id, user.role, sessionId), user: toPublicUser(user) };
}

export async function refreshAccessToken(incomingRefreshToken: string): Promise<AuthTokens> {
  const { tokenHash, user, sessionId } = await resolveRefreshTokenUser(incomingRefreshToken);
  const refreshToken = signRefreshToken(user.id, sessionId);
  // A conditional single-row replacement is atomic: a failed write leaves the
  // prior cookie usable, while a concurrent reuse cannot rotate twice.
  const replaced = await prisma.refreshToken.updateMany({
    where: { id: sessionId, token: tokenHash, expiresAt: { gt: new Date() } },
    data: { token: hashOpaqueToken(refreshToken), expiresAt: refreshTokenExpiresAt() },
  });
  if (replaced.count !== 1) {
    const err = new Error("Refresh token already used or revoked") as any;
    err.status = 401;
    throw err;
  }
  return { accessToken: signAccessToken(user.id, user.role, sessionId), refreshToken };
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function logoutUser(refreshToken: string): Promise<void> {
  let identity: { sub?: string; sid?: string } | null = null;
  try {
    const claims = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET, { ignoreExpiration: true });
    if (typeof claims !== "string") identity = claims;
  } catch {
    // A pre-existing opaque or malformed cookie can only be looked up by hash.
  }
  const session = identity?.sub && identity.sid
    ? await prisma.refreshToken.findFirst({ where: { id: identity.sid, userId: identity.sub }, select: { id: true } })
    : await prisma.refreshToken.findUnique({ where: { token: hashOpaqueToken(refreshToken) }, select: { id: true } });
  if (!session) return;
  await prisma.refreshToken.deleteMany({ where: { id: session.id } });
  await disconnectSessionSockets(session.id, "You signed out of this browser.");
}

// ── Verify Email ──────────────────────────────────────────────────────────────

export async function verifyEmail(token: string): Promise<void> {
  const tokenHash = hashOpaqueToken(token);
  const record = await prisma.emailVerificationToken.findUnique({ where: { token: tokenHash } });

  const invalidErr = new Error("Invalid or expired verification link") as any;
  invalidErr.status = 400;

  if (!record) throw invalidErr;

  // Reopening a consumed link is harmless and remains successful. This also
  // handles development-mode duplicate effects and safe network retries.
  if (record.used) return;

  if (record.expiresAt < new Date()) {
    await prisma.emailVerificationToken.deleteMany({ where: { token: tokenHash } });
    throw invalidErr;
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: true },
    }),
    prisma.emailVerificationToken.update({
      where: { token: tokenHash },
      data: { used: true },
    }),
  ]);
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
    data: { token: hashOpaqueToken(token), userId: user.id, expiresAt },
  });

  await sendVerificationEmail(user.email, user.name, token);
}

// ── Forgot Password ───────────────────────────────────────────────────────────

export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });

  // Always return success regardless of whether email exists (anti-enumeration)
  if (!user || user.passwordState === "NONE" || (user.passwordState === "LEGACY_UNCONFIRMED" && user.googleSubject)) return;

  // Invalidate any existing reset tokens for this user
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  await prisma.passwordResetToken.create({
    data: { token: hashOpaqueToken(token), userId: user.id, expiresAt },
  });

  await sendPasswordResetEmail(user.email, user.name, token);
}

// ── Reset Password ────────────────────────────────────────────────────────────

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  StrongPasswordSchema.parse(newPassword);
  const tokenHash = hashOpaqueToken(token);
  const record = await prisma.passwordResetToken.findUnique({ where: { token: tokenHash } });

  const invalidErr = new Error("Invalid or expired reset link") as any;
  invalidErr.status = 400;

  if (!record || record.used || record.expiresAt < new Date()) throw invalidErr;

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    await lockAccountLifecycle(tx, record.userId);
    await lockAuthenticationSession(tx, record.userId);
    const user = await tx.user.findUnique({ where: { id: record.userId } });
    if (!user || user.deactivatedAt || !user.isActive || user.passwordState === "NONE" || (user.passwordState === "LEGACY_UNCONFIRMED" && user.googleSubject)) throw invalidErr;
    const claimed = await tx.passwordResetToken.updateMany({
      where: { token: tokenHash, used: false, expiresAt: { gt: new Date() } },
      data: { used: true },
    });
    if (claimed.count !== 1) throw invalidErr;
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash, passwordState: "SET" } });
    await tx.refreshToken.deleteMany({ where: { userId: record.userId } });
  });
  await disconnectUserSockets(record.userId, "Your password was reset. Please sign in again.");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function issueTokens(userId: string, expectedPasswordHash: string, passwordAuthenticated = false): Promise<AuthTokens & { moderationStatus: string }> {
  const session = await prisma.$transaction(async (tx) => {
    await lockAccountLifecycle(tx, userId);
    await lockAuthenticationSession(tx, userId);
    const current = await tx.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, passwordState: true, role: true, isActive: true, moderationStatus: true, deactivatedAt: true },
    });
    // Authentication may have started before a password reset/change. The
    // snapshot validated outside this transaction is no longer sufficient.
    if (!current || current.deactivatedAt || (!current.isActive && current.moderationStatus !== "BANNED") || current.passwordHash !== expectedPasswordHash) {
      const error = new Error("Invalid credentials") as Error & { status?: number };
      error.status = 401;
      throw error;
    }
    if (passwordAuthenticated) {
      if (current.passwordState === "NONE") throw Object.assign(new Error("Invalid credentials"), { status: 401 });
      if (current.passwordState === "LEGACY_UNCONFIRMED") await tx.user.update({ where: { id: userId }, data: { passwordState: "SET" } });
    }
    const created = await tx.refreshToken.create({
      data: { token: hashOpaqueToken(generateSecureToken()), userId, expiresAt: refreshTokenExpiresAt() },
    });
    const refreshToken = signRefreshToken(userId, created.id);
    await tx.refreshToken.update({ where: { id: created.id }, data: { token: hashOpaqueToken(refreshToken) } });
    return { id: created.id, role: current.role, moderationStatus: current.moderationStatus, refreshToken };
  });
  return { accessToken: signAccessToken(userId, session.role, session.id), refreshToken: session.refreshToken, moderationStatus: session.moderationStatus };
}

export function toPublicUser(user: any): AuthUser {
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
    onboardingStatus: user.onboardingStatus,
    moderationStatus: user.moderationStatus,
    signInMethods: signInMethods(user),
  };
}

export async function googleLoginUser(token: string): Promise<{ user: AuthUser; tokens: AuthTokens }> {
  let email: string;
  let name: string;
  let avatarUrl: string | null = null;
  let googleSubject: string;

  try {
    if (!env.GOOGLE_CLIENT_ID) {
      const error = new Error("Google sign-in is not configured") as any;
      error.status = 503;
      throw error;
    }
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error("Token validation failed");
    }
    const data = (await response.json()) as any;
    if (!data.email || typeof data.sub !== "string" || !data.sub) {
      throw new Error("Email field missing in Google profile");
    }

    // Require the exact configured OAuth client and a verified Google account.
    if (data.aud !== env.GOOGLE_CLIENT_ID ||
        !["accounts.google.com", "https://accounts.google.com"].includes(data.iss) ||
        data.email_verified !== "true" && data.email_verified !== true || !Number.isFinite(Number(data.exp)) || Number(data.exp) <= Date.now() / 1000) {
    throw new Error("Google token claims are invalid");
    }

    email = data.email.trim().toLowerCase();
    googleSubject = data.sub;
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
  let user = await prisma.user.findUnique({ where: { googleSubject } }) ?? await prisma.user.findUnique({ where: { email } });

  if (user) {
    if (user.deactivatedAt || (!user.isActive && user.moderationStatus !== "BANNED")) {
      const err = new Error("Your account has been suspended. Please contact support.") as any;
      err.status = 403;
      throw err;
    }

    if (user.googleSubject && user.googleSubject !== googleSubject) throw Object.assign(new Error("This email is connected to a different Google account."), { status: 403 });
    const accountId = user.id;
    user = await prisma.$transaction(async tx => {
      await lockAccountLifecycle(tx, accountId);
      await lockAuthenticationSession(tx, accountId);
      const latest = await tx.user.findUniqueOrThrow({ where: { id: accountId } });
      if (latest.deactivatedAt || (!latest.isActive && latest.moderationStatus !== "BANNED")) throw Object.assign(new Error("Account inactive"), { status: 403 });
      if (latest.googleSubject && latest.googleSubject !== googleSubject) throw Object.assign(new Error("Google account does not match."), { status: 403 });
      return tx.user.update({ where: { id: accountId }, data: { emailVerified: true, googleSubject, googleConnectedAt: latest.googleConnectedAt ?? new Date() } });
    });

    const tokens = await issueTokens(user.id, user.passwordHash);
    return { user: toPublicUser({ ...user, moderationStatus: tokens.moderationStatus }), tokens };
  } else {
    // 2. Auto-create new user from Google profile
    // Note: phone and location are null — the frontend must detect this and
    // prompt the user to complete their profile (Contact Info step) before
    // they can perform verified actions. This is intentional per Part 4.
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, SALT_ROUNDS);

    user = await prisma.$transaction(async tx => {
      const created = await tx.user.create({
        data: {
          name,
          email,
          passwordHash,
          passwordState: "NONE",
          googleSubject,
          googleConnectedAt: new Date(),
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

      await tx.trustScoreEvent.create({ data: { userId: created.id, delta: 50,
        reason: "Initial Account Base Trust Score Baseline", scoreBefore: 0, scoreAfter: 50,
        eventKey: `account-baseline:${created.id}` } });
      return created;
    });

    const tokens = await issueTokens(user.id, user.passwordHash);

    return { user: toPublicUser(user), tokens };
  }
}
