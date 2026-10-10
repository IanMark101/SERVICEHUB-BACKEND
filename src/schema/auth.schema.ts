import { z } from "zod";
import { StrongPasswordSchema } from "./password.schema";

// ── Register ─────────────────────────────────────────────────────────────────
export const RegisterSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email format"),
  password: StrongPasswordSchema,
  phone: z
    .string()
    .regex(/^(\+63\s?9|09)\d{2}\s?\d{3}\s?\d{4}$/, "Phone must be a valid PH mobile number (e.g. 0917 123 4567 or +63 917 123 4567)"),
  location: z.string().trim().min(1, "Location is required").max(100),
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
  password: StrongPasswordSchema,
  confirmPassword: z.string().min(1, "Confirm your new password."),
}).strict().refine(data => data.password === data.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match." });

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

// ── Change Password (authenticated) ─────────────────────────────────────────
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: StrongPasswordSchema,
  confirmPassword: z.string().min(1, "Confirm your new password."),
}).strict().refine(data => data.newPassword === data.confirmPassword, {
  path: ["confirmPassword"], message: "Passwords do not match.",
});

export const GoogleLoginSchema = z.object({ token: z.string().trim().min(20).max(4_096) }).strict();

const OptionalHttpsUrlOrEmpty = z.string().trim().superRefine((value, context) => {
  if (value === "") return;
  try {
    if (new URL(value).protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Links must start with https://." });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Enter a valid link, such as https://example.com." });
  }
});

export const UpdateProfileSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name using at least 2 characters.").max(100, "Your name must be at most 100 characters.").optional(),
  bio: z.string().trim().max(1_000, "Your bio must be at most 1,000 characters.").optional(),
  phone: z.string().trim().regex(/^([+]63\s?9|09)\d{2}\s?\d{3}\s?\d{4}$/, "Enter a valid Philippine mobile number, such as 0917 123 4567 or +63 917 123 4567.").optional(),
  location: z.string().trim().min(1, "Enter your general city or municipality and barangay.").max(100, "Your profile area must be at most 100 characters.").optional(),
  avatarUrl: OptionalHttpsUrlOrEmpty.optional(),
  facebookUrl: OptionalHttpsUrlOrEmpty.optional(),
  instagramUrl: OptionalHttpsUrlOrEmpty.optional(),
  websiteUrl: OptionalHttpsUrlOrEmpty.optional(),
  currentPassword: z.string().min(1).max(256).optional(),
}).strict();

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
