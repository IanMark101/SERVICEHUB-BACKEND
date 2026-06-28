"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChangePasswordSchema = exports.ResetPasswordSchema = exports.ForgotPasswordSchema = exports.LoginSchema = exports.RegisterSchema = void 0;
const zod_1 = require("zod");
// ── Register ─────────────────────────────────────────────────────────────────
exports.RegisterSchema = zod_1.z.object({
    name: zod_1.z.string().min(2, "Name must be at least 2 characters"),
    email: zod_1.z.string().email("Invalid email format"),
    password: zod_1.z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/\d/, "Password must contain at least one number"),
    phone: zod_1.z
        .string()
        .regex(/^\+63\s?9\d{2}\s?\d{3}\s?\d{4}$/, "Phone must be a valid PH mobile number (e.g. +63 917 123 4567)"),
    location: zod_1.z.string().min(1, "Location is required"),
    bio: zod_1.z.string().optional(),
    avatarUrl: zod_1.z.string().url().optional(),
});
// ── Login ────────────────────────────────────────────────────────────────────
exports.LoginSchema = zod_1.z.object({
    email: zod_1.z.string().email("Invalid email format"),
    password: zod_1.z.string().min(1, "Password is required"),
});
// ── Forgot Password ──────────────────────────────────────────────────────────
exports.ForgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email("Invalid email format"),
});
// ── Reset Password ───────────────────────────────────────────────────────────
exports.ResetPasswordSchema = zod_1.z.object({
    token: zod_1.z.string().min(1),
    password: zod_1.z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/\d/, "Password must contain at least one number"),
});
// ── Change Password (authenticated) ─────────────────────────────────────────
exports.ChangePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1),
    newPassword: zod_1.z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/\d/, "Password must contain at least one number"),
});
//# sourceMappingURL=auth.schema.js.map