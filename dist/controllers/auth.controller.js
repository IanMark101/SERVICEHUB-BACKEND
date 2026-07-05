"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
exports.login = login;
exports.refresh = refresh;
exports.logout = logout;
exports.verifyEmailHandler = verifyEmailHandler;
exports.forgotPasswordHandler = forgotPasswordHandler;
exports.resetPasswordHandler = resetPasswordHandler;
exports.getMe = getMe;
exports.googleLogin = googleLogin;
const auth_schema_1 = require("../schema/auth.schema");
const auth_service_1 = require("../services/auth.service");
const env_1 = require("../config/env");
// ── Cookie config ─────────────────────────────────────────────────────────────
const REFRESH_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: env_1.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    path: "/",
};
// ── POST /auth/register ───────────────────────────────────────────────────────
async function register(req, res, next) {
    try {
        const input = auth_schema_1.RegisterSchema.parse(req.body);
        const { user, tokens } = await (0, auth_service_1.registerUser)(input);
        res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
        res.status(201).json({
            success: true,
            message: "Account created. Please verify your email to unlock full access.",
            data: { user, accessToken: tokens.accessToken },
        });
    }
    catch (err) {
        // Zod validation errors
        if (err.name === "ZodError") {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        next(err);
    }
}
// ── POST /auth/login ──────────────────────────────────────────────────────────
async function login(req, res, next) {
    try {
        const input = auth_schema_1.LoginSchema.parse(req.body);
        const { user, tokens } = await (0, auth_service_1.loginUser)(input);
        res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
        res.json({
            success: true,
            data: { user, accessToken: tokens.accessToken },
        });
    }
    catch (err) {
        if (err.name === "ZodError") {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        next(err);
    }
}
// ── POST /auth/refresh ────────────────────────────────────────────────────────
async function refresh(req, res, next) {
    try {
        const incomingToken = req.cookies?.refreshToken;
        if (!incomingToken) {
            return res.status(401).json({ success: false, error: "No refresh token provided" });
        }
        const tokens = await (0, auth_service_1.refreshAccessToken)(incomingToken);
        // Rotate the cookie
        res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
        res.json({ success: true, data: { accessToken: tokens.accessToken } });
    }
    catch (err) {
        next(err);
    }
}
// ── POST /auth/logout ─────────────────────────────────────────────────────────
async function logout(req, res, next) {
    try {
        const token = req.cookies?.refreshToken;
        if (token) {
            await (0, auth_service_1.logoutUser)(token);
        }
        res.clearCookie("refreshToken", { path: "/" });
        res.json({ success: true, message: "Logged out successfully" });
    }
    catch (err) {
        next(err);
    }
}
// ── GET /auth/verify-email/:token ─────────────────────────────────────────────
async function verifyEmailHandler(req, res, next) {
    try {
        const { token } = req.params;
        await (0, auth_service_1.verifyEmail)(token);
        // Redirect to frontend with success state
        res.redirect(`${env_1.env.FRONTEND_URL}?emailVerified=true`);
    }
    catch (err) {
        next(err);
    }
}
// ── POST /auth/forgot-password ────────────────────────────────────────────────
async function forgotPasswordHandler(req, res, next) {
    try {
        const input = auth_schema_1.ForgotPasswordSchema.parse(req.body);
        await (0, auth_service_1.forgotPassword)(input.email);
        // Always 200 — do not reveal if email exists
        res.json({
            success: true,
            message: "If an account with that email exists, a reset link has been sent.",
        });
    }
    catch (err) {
        if (err.name === "ZodError") {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        next(err);
    }
}
// ── POST /auth/reset-password ─────────────────────────────────────────────────
async function resetPasswordHandler(req, res, next) {
    try {
        const input = auth_schema_1.ResetPasswordSchema.parse(req.body);
        await (0, auth_service_1.resetPassword)(input.token, input.password);
        // Invalidate session on password reset
        res.clearCookie("refreshToken", { path: "/" });
        res.json({ success: true, message: "Password reset successfully. Please log in again." });
    }
    catch (err) {
        if (err.name === "ZodError") {
            return res.status(400).json({ success: false, errors: err.errors });
        }
        next(err);
    }
}
// ── GET /auth/me ──────────────────────────────────────────────────────────────
// Returns current user from the JWT (set by requireAuth middleware)
async function getMe(req, res) {
    res.json({ success: true, data: { user: req.user } });
}
// ── POST /auth/google-login ───────────────────────────────────────────────────
async function googleLogin(req, res, next) {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ success: false, error: "Google token is required" });
        }
        const { user, tokens } = await (0, auth_service_1.googleLoginUser)(token);
        res.cookie("refreshToken", tokens.refreshToken, REFRESH_COOKIE_OPTIONS);
        res.json({
            success: true,
            data: { user, accessToken: tokens.accessToken },
        });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=auth.controller.js.map