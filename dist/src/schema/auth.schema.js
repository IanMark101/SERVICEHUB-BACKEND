import { z } from "zod";
// ── Register ─────────────────────────────────────────────────────────────────
export const RegisterSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    email: z.string().email("Invalid email format"),
    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/\d/, "Password must contain at least one number")
        .regex(/[A-Z]/, "Password must contain at least one uppercase letter"),
    phone: z
        .string()
        .regex(/^(\+63\s?9|09)\d{2}\s?\d{3}\s?\d{4}$/, "Phone must be a valid PH mobile number (e.g. 0917 123 4567 or +63 917 123 4567)"),
    location: z.string().min(1, "Location is required"),
    bio: z.string().optional(),
    avatarUrl: z.string().url().optional(),
});
// ── Login ────────────────────────────────────────────────────────────────────
export const LoginSchema = z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(1, "Password is required"),
});
// ── Forgot Password ──────────────────────────────────────────────────────────
export const ForgotPasswordSchema = z.object({
    email: z.string().email("Invalid email format"),
});
// ── Reset Password ───────────────────────────────────────────────────────────
export const ResetPasswordSchema = z.object({
    token: z.string().min(1),
    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/\d/, "Password must contain at least one number")
        .regex(/[A-Z]/, "Password must contain at least one uppercase letter"),
});
// ── Change Password (authenticated) ─────────────────────────────────────────
export const ChangePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .regex(/\d/, "Password must contain at least one number")
        .regex(/[A-Z]/, "Password must contain at least one uppercase letter"),
});
//# sourceMappingURL=auth.schema.js.map