"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireAdmin = requireAdmin;
exports.requireEmailVerified = requireEmailVerified;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
// ── requireAuth ───────────────────────────────────────────────────────────────
// Validates Bearer JWT, attaches full user object to req.user
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, error: "Authentication required" });
    }
    const token = authHeader.split(" ")[1];
    try {
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_ACCESS_SECRET);
        const user = await prisma_1.prisma.user.findUnique({
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
        req.user = user;
        next();
    }
    catch (err) {
        return res.status(401).json({ success: false, error: "Invalid or expired token" });
    }
}
// ── requireAdmin ──────────────────────────────────────────────────────────────
// Must be chained AFTER requireAuth
function requireAdmin(req, res, next) {
    const user = req.user;
    if (!user || user.role !== "admin") {
        return res.status(403).json({ success: false, error: "Admin access required" });
    }
    next();
}
// ── requireEmailVerified ──────────────────────────────────────────────────────
// Blocks access for unverified email users on sensitive endpoints
function requireEmailVerified(req, res, next) {
    const user = req.user;
    if (!user.emailVerified) {
        return res.status(403).json({
            success: false,
            error: "Please verify your email address first",
            code: "EMAIL_NOT_VERIFIED",
        });
    }
    next();
}
//# sourceMappingURL=auth.middleware.js.map