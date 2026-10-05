import { z } from "zod";

export const StrongPasswordSchema = z.string()
  .min(8, "Use at least 8 characters.")
  .refine(value => Buffer.byteLength(value, "utf8") <= 72, "Use at most 72 bytes (fewer characters when using emoji).")
  .regex(/[A-Z]/, "Include an uppercase letter.")
  .regex(/[a-z]/, "Include a lowercase letter.")
  .regex(/[0-9]/, "Include a number.")
  .regex(/[^A-Za-z0-9\s]/, "Include a special character.");

export const SetPasswordSchema = z.object({
  grant: z.string().min(20).max(4096),
  newPassword: StrongPasswordSchema,
  confirmPassword: z.string().min(1, "Confirm your new password."),
}).strict().refine(data => data.newPassword === data.confirmPassword, {
  path: ["confirmPassword"], message: "Passwords do not match.",
});

export const VerifyPasswordGoogleSchema = z.object({
  challenge: z.string().min(20).max(4096),
  credential: z.string().min(20).max(8192),
}).strict();
