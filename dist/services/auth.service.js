"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUser = registerUser;
exports.loginUser = loginUser;
exports.refreshAccessToken = refreshAccessToken;
exports.logoutUser = logoutUser;
exports.verifyEmail = verifyEmail;
exports.forgotPassword = forgotPassword;
exports.resetPassword = resetPassword;
exports.googleLoginUser = googleLoginUser;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
const email_1 = require("../utils/email");
// ── Helpers ───────────────────────────────────────────────────────────────────
const SALT_ROUNDS = 12;
function generateSecureToken() {
    return crypto_1.default.randomBytes(32).toString("hex");
}
function signAccessToken(userId, role) {
    return jsonwebtoken_1.default.sign({ sub: userId, role }, env_1.env.JWT_ACCESS_SECRET, { expiresIn: env_1.env.JWT_ACCESS_EXPIRES_IN });
}
function signRefreshToken(userId) {
    return jsonwebtoken_1.default.sign({ sub: userId }, env_1.env.JWT_REFRESH_SECRET, { expiresIn: env_1.env.JWT_REFRESH_EXPIRES_IN });
}
function refreshTokenExpiresAt() {
    const d = new Date();
    d.setDate(d.getDate() + 7); // 7 days
    return d;
}
// ── Register ──────────────────────────────────────────────────────────────────
async function registerUser(input) {
    // Check for duplicate email
    const existing = await prisma_1.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
        const err = new Error("An account with this email already exists");
        err.status = 409;
        throw err;
    }
    const passwordHash = await bcryptjs_1.default.hash(input.password, SALT_ROUNDS);
    const user = await prisma_1.prisma.user.create({
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
    await prisma_1.prisma.emailVerificationToken.create({
        data: { token: verifyToken, userId: user.id, expiresAt: verifyExpiry },
    });
    // Send verification email (logs to console in dev)
    await (0, email_1.sendVerificationEmail)(user.email, user.name, verifyToken);
    // Issue JWT tokens
    const tokens = await issueTokens(user.id, user.role);
    return { user: toPublicUser(user), tokens };
}
// ── Login ─────────────────────────────────────────────────────────────────────
async function loginUser(input) {
    const user = await prisma_1.prisma.user.findUnique({ where: { email: input.email } });
    // Generic error — never reveal whether email exists (master prompt rule)
    const invalidErr = new Error("Invalid credentials");
    invalidErr.status = 401;
    if (!user)
        throw invalidErr;
    const passwordValid = await bcryptjs_1.default.compare(input.password, user.passwordHash);
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
async function refreshAccessToken(incomingRefreshToken) {
    // Verify the token is signed correctly first
    let payload;
    try {
        payload = jsonwebtoken_1.default.verify(incomingRefreshToken, env_1.env.JWT_REFRESH_SECRET);
    }
    catch {
        const err = new Error("Invalid or expired refresh token");
        err.status = 401;
        throw err;
    }
    // Find it in DB (rotation: each token can only be used once)
    const stored = await prisma_1.prisma.refreshToken.findUnique({ where: { token: incomingRefreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
        const err = new Error("Refresh token not found or expired");
        err.status = 401;
        throw err;
    }
    const user = await prisma_1.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || !user.isActive) {
        const err = new Error("User not found or suspended");
        err.status = 401;
        throw err;
    }
    // Rotate: delete old, issue new pair
    await prisma_1.prisma.refreshToken.delete({ where: { token: incomingRefreshToken } });
    return issueTokens(user.id, user.role);
}
// ── Logout ────────────────────────────────────────────────────────────────────
async function logoutUser(refreshToken) {
    // Silently ignore if token not found (idempotent)
    await prisma_1.prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
}
// ── Verify Email ──────────────────────────────────────────────────────────────
async function verifyEmail(token) {
    const record = await prisma_1.prisma.emailVerificationToken.findUnique({ where: { token } });
    const invalidErr = new Error("Invalid or expired verification link");
    invalidErr.status = 400;
    if (!record || record.expiresAt < new Date())
        throw invalidErr;
    await prisma_1.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true },
    });
    await prisma_1.prisma.emailVerificationToken.delete({ where: { token } });
}
// ── Forgot Password ───────────────────────────────────────────────────────────
async function forgotPassword(email) {
    const user = await prisma_1.prisma.user.findUnique({ where: { email } });
    // Always return success regardless of whether email exists (anti-enumeration)
    if (!user)
        return;
    // Invalidate any existing reset tokens for this user
    await prisma_1.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    const token = generateSecureToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await prisma_1.prisma.passwordResetToken.create({
        data: { token, userId: user.id, expiresAt },
    });
    await (0, email_1.sendPasswordResetEmail)(user.email, user.name, token);
}
// ── Reset Password ────────────────────────────────────────────────────────────
async function resetPassword(token, newPassword) {
    const record = await prisma_1.prisma.passwordResetToken.findUnique({ where: { token } });
    const invalidErr = new Error("Invalid or expired reset link");
    invalidErr.status = 400;
    if (!record || record.used || record.expiresAt < new Date())
        throw invalidErr;
    const passwordHash = await bcryptjs_1.default.hash(newPassword, SALT_ROUNDS);
    // Update password
    await prisma_1.prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
    });
    // Invalidate reset token and all refresh tokens (all sessions)
    await prisma_1.prisma.passwordResetToken.update({ where: { token }, data: { used: true } });
    await prisma_1.prisma.refreshToken.deleteMany({ where: { userId: record.userId } });
}
// ── Internal helpers ──────────────────────────────────────────────────────────
async function issueTokens(userId, role) {
    const accessToken = signAccessToken(userId, role);
    const refreshToken = signRefreshToken(userId);
    await prisma_1.prisma.refreshToken.create({
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
async function googleLoginUser(token) {
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
        if (env_1.env.GOOGLE_CLIENT_ID && data.aud && data.aud !== env_1.env.GOOGLE_CLIENT_ID) {
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
    let user = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (user) {
        if (!user.isActive) {
            const err = new Error("Your account has been suspended. Please contact support.");
            err.status = 403;
            throw err;
        }
        // Auto-verify email upon Google sign-in since Google already verified it
        if (!user.emailVerified) {
            user = await prisma_1.prisma.user.update({
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
        const randomPassword = crypto_1.default.randomBytes(32).toString("hex");
        const passwordHash = await bcryptjs_1.default.hash(randomPassword, SALT_ROUNDS);
        user = await prisma_1.prisma.user.create({
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
//# sourceMappingURL=auth.service.js.map