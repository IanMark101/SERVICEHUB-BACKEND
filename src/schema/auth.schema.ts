import { z } from "zod";

// ── Register ─────────────────────────────────────────────────────────────────
export const RegisterSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email format"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/\d/, "Password must contain at least one number"),
  phone: z
    .string()
    .regex(/^\+63\s?9\d{2}\s?\d{3}\s?\d{4}$/, "Phone must be a valid PH mobile number (e.g. +63 917 123 4567)"),
  location: z.string().min(1, "Location is required"),
  bio: z.string().optional(),
  avatarUrl: z.string().url().optional(),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;

// ── Login ────────────────────────────────────────────────────────────────────
export const LoginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof LoginSchema>;

// ── Forgot Password ──────────────────────────────────────────────────────────
export const ForgotPasswordSchema = z.object({
  email: z.string().email("Invalid email format"),
});

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

// ── Reset Password ───────────────────────────────────────────────────────────
export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/\d/, "Password must contain at least one number"),
});

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

// ── Change Password (authenticated) ─────────────────────────────────────────
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/\d/, "Password must contain at least one number"),
});

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
