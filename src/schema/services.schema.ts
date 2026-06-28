import { z } from "zod";

export const CreateServiceSchema = z.object({
  categoryId: z.string().cuid("Invalid category"),
  title: z
    .string()
    .min(10, "Title must be at least 10 characters")
    .max(100, "Title must be at most 100 characters")
    .regex(/^[a-zA-Z0-9\s,.'&()-]+$/, "Title contains invalid characters"),
  description: z
    .string()
    .min(30, "Description must be at least 30 characters")
    .max(1000, "Description must be at most 1000 characters"),
  price: z
    .number()
    .min(50, "Price must be at least ₱50")
    .max(50000, "Price must be at most ₱50,000"),
  priceType: z.enum(["FIXED", "STARTS_AT", "PER_HOUR"]).default("FIXED"),
  estimatedDurationMins: z
    .number()
    .min(15, "Duration must be at least 15 minutes")
    .max(480, "Duration must be at most 8 hours (480 minutes)"),
  queueLimit: z
    .number()
    .int("Queue limit must be a whole number")
    .min(1, "Queue limit must be at least 1")
    .max(10, "Queue limit must be at most 10"),
  paymentMethods: z
    .object({
      gcash: z.boolean().default(false),
      maya: z.boolean().default(false),
      cash: z.boolean().default(false),
    })
    .refine(
      (pm) => pm.gcash || pm.maya || pm.cash,
      "At least one payment method must be selected"
    ),
});

export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;

export const UpdateServiceSchema = z.object({
  title: z
    .string()
    .min(10)
    .max(100)
    .regex(/^[a-zA-Z0-9\s,.'&()-]+$/)
    .optional(),
  description: z.string().min(30).max(1000).optional(),
  price: z.number().min(50).max(50000).optional(),
  priceType: z.enum(["FIXED", "STARTS_AT", "PER_HOUR"]).optional(),
  estimatedDurationMins: z.number().min(15).max(480).optional(),
  queueLimit: z.number().int().min(1).max(10).optional(),
  paymentMethods: z
    .object({
      gcash: z.boolean(),
      maya: z.boolean(),
      cash: z.boolean(),
    })
    .optional(),
  categoryId: z.string().cuid().optional(),
});

export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>;
