import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { sendVerificationEmail, sendPasswordResetEmail } from "../utils/email";
// ── Helpers ───────────────────────────────────────────────────────────────────
const SALT_ROUNDS = 12;
function generateSecureToken() {
    return crypto.randomBytes(32).toString("hex");
}
function signAccessToken(userId, role) {
    return jwt.sign({ sub: userId, role }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES_IN });
}
function signRefreshToken(userId) {
    return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES_IN });
}
function refreshTokenExpiresAt() {
    const d = new Date();
    d.setDate(d.getDate() + 7); // 7 days
    return d;
}
// ── Register ──────────────────────────────────────────────────────────────────
export async function registerUser(input) {
    // Check for duplicate email
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
        const err = new Error("An account with this email already exists");
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
export async function loginUser(input) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    // Generic error — never reveal whether email exists (master prompt rule)
    const invalidErr = new Error("Invalid credentials");
    invalidErr.status = 401;
    if (!user)
        throw invalidErr;
    const passwordValid = await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordValid)
        throw invalidErr;
    if (!user.isActive) {
        const err = new Error("Your account has been suspended. Please contact support.");
        err.status = 403;
        throw err;
    }
    if (!user.emailVerified) {
        const err = new Error("Please verify your email before logging in. Check your inbox for the verification link.");
        err.status = 403;
        err.code = "EMAIL_UNVERIFIED";
        throw err;
    }
    const tokens = await issueTokens(user.id, user.role);
    return { user: toPublicUser(user), tokens };
}
// ── Refresh Token ─────────────────────────────────────────────────────────────
export async function refreshAccessToken(incomingRefreshToken) {
    // Verify the token is signed correctly first
    let payload;
    try {
        payload = jwt.verify(incomingRefreshToken, env.JWT_REFRESH_SECRET);
    }
    catch {
        const err = new Error("Invalid or expired refresh token");
        err.status = 401;
        throw err;
    }
    // Find it in DB (rotation: each token can only be used once)
    const stored = await prisma.refreshToken.findUnique({ where: { token: incomingRefreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
        const err = new Error("Refresh token not found or expired");
        err.status = 401;
        throw err;
    }
    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || !user.isActive) {
        const err = new Error("User not found or suspended");
        err.status = 401;
        throw err;
    }
    // Rotate: delete old, issue new pair
    await prisma.refreshToken.delete({ where: { token: incomingRefreshToken } });
    return issueTokens(user.id, user.role);
}
// ── Logout ────────────────────────────────────────────────────────────────────
export async function logoutUser(refreshToken) {
    // Silently ignore if token not found (idempotent)
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
}
// ── Verify Email ──────────────────────────────────────────────────────────────
export async function verifyEmail(token) {
    const record = await prisma.emailVerificationToken.findUnique({ where: { token } });
    const invalidErr = new Error("Invalid or expired verification link");
    invalidErr.status = 400;
    if (!record || record.expiresAt < new Date())
        throw invalidErr;
    await prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true },
    });
    await prisma.emailVerificationToken.delete({ where: { token } });
}
export async function resendVerificationEmail(email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user)
        return; // Silent return for privacy
    if (user.emailVerified)
        return; // Silent return if already verified
    // Rate Limiting: Check if a token was created in the last 60 seconds
    const existingToken = await prisma.emailVerificationToken.findFirst({
        where: { userId: user.id },
    });
    if (existingToken && Date.now() - existingToken.createdAt.getTime() < 60 * 1000) {
        const err = new Error("Please wait 60 seconds before requesting another verification email.");
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
export async function forgotPassword(email) {
    const user = await prisma.user.findUnique({ where: { email } });
    // Always return success regardless of whether email exists (anti-enumeration)
    if (!user)
        return;
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
export async function resetPassword(token, newPassword) {
    const record = await prisma.passwordResetToken.findUnique({ where: { token } });
    const invalidErr = new Error("Invalid or expired reset link");
    invalidErr.status = 400;
    if (!record || record.used || record.expiresAt < new Date())
        throw invalidErr;
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
async function issueTokens(userId, role) {
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
function toPublicUser(user) {
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
export async function googleLoginUser(token) {
    let email;
    let name;
    let avatarUrl = null;
    try {
        const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
        if (!response.ok) {
            throw new Error("Token validation failed");
        }
        const data = (await response.json());
        if (!data.email) {
            throw new Error("Email field missing in Google profile");
        }
        // Secure check: Verify the Google Client ID/Audience if configured in env
        if (env.GOOGLE_CLIENT_ID && data.aud && data.aud !== env.GOOGLE_CLIENT_ID) {
            throw new Error("Token audience mismatch");
        }
        email = data.email;
        name = data.name || email.split("@")[0];
        avatarUrl = data.picture || null;
    }
    catch (err) {
        const error = new Error(`Google sign-in failed: ${err.message}`);
        error.status = 401;
        throw error;
    }
    // 1. Check for existing user by email
    let user = await prisma.user.findUnique({ where: { email } });
    if (user) {
        if (!user.isActive) {
            const err = new Error("Your account has been suspended. Please contact support.");
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
    }
    else {
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
                phone: "", // Will be collected during profile completion step
                location: "", // Will be collected during profile completion step (barangay)
                avatarUrl,
                trustScore: 50,
                verificationStatus: "UNVERIFIED",
                emailVerified: true, // Auto-verified — Google already confirmed this email
                isActive: true,
                role: "user", // Defaults to 'user', switchable to seeker/provider in frontend dashboard
            },
        });
        const tokens = await issueTokens(user.id, user.role);
        return { user: toPublicUser(user), tokens };
    }
}
// ── Public & Edit Profile Services ───────────────────────────────────────────
export async function getUserPublicProfile(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            location: true,
            avatarUrl: true,
            bio: true,
            role: true,
            trustScore: true,
            verificationStatus: true,
            createdAt: true,
        },
    });
    if (!user) {
        const err = new Error("User not found");
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
        averageRating: avgRatingResult._avg.rating || 5.0,
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
export async function updateUserProfile(userId, data) {
    const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.bio !== undefined && { bio: data.bio }),
            ...(data.phone !== undefined && { phone: data.phone }),
            ...(data.location !== undefined && { location: data.location }),
            ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
        },
    });
    return toPublicUser(updatedUser);
}
export async function changeUserPassword(userId, currentPassword, newPassword) {
    if (!currentPassword || !newPassword) {
        const err = new Error("Current and new password are required");
        err.status = 400;
        throw err;
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        const err = new Error("User not found");
        err.status = 404;
        throw err;
    }
    const passwordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!passwordValid) {
        const err = new Error("Current password is incorrect");
        err.status = 400;
        throw err;
    }
    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: newHash },
    });
    return { success: true };
}
//# sourceMappingURL=auth.service.js.map