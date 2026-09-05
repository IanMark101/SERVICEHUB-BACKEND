import { z } from "zod";

export const PriceTypeValues = [
  "FIXED", "STARTS_AT", "PER_HOUR", "PER_SESSION", "PER_DAY", "PER_PROJECT", "CUSTOM",
] as const;
export type PriceTypeValue = typeof PriceTypeValues[number];

export const ServiceTypeValues = ["ONE_TIME", "SESSION_BASED"] as const;
export type ServiceTypeValue = typeof ServiceTypeValues[number];

const title = z.string()
  .trim()
  .min(10, "Title must be at least 10 characters")
  .max(100, "Title must be at most 100 characters")
  .regex(/^[a-zA-Z0-9\s,.'&()-]+$/, "Title contains invalid characters");

const description = z.string()
  .trim()
  .min(30, "Description must be at least 30 characters")
  .max(1000, "Description must be at most 1000 characters");

const price = z.number()
  .finite()
  .min(50, "Price must be at least PHP 50")
  .max(50_000, "Price must be at most PHP 50,000");

const paymentMethods = z.object({
  gcash: z.boolean().default(false),
  maya: z.boolean().default(false),
  card: z.literal(false).default(false),
  cash: z.boolean().default(false),
}).refine(
  (methods) => methods.gcash || methods.maya || methods.card || methods.cash,
  "At least one payment method must be selected",
);

export const CreateServiceSchema = z.object({
  categoryId: z.string().min(1, "Invalid category"),
  title,
  description,
  price: price.optional(),
  priceType: z.enum(PriceTypeValues).default("FIXED"),
  serviceType: z.enum(ServiceTypeValues).default("ONE_TIME"),
  estimatedDurationMins: z.number().min(15).max(480),
  queueLimit: z.number().int().min(1).max(10),
  paymentMethods,
}).superRefine((value, context) => {
  if (value.priceType !== "CUSTOM" && value.price === undefined) {
    context.addIssue({ code: "custom", path: ["price"], message: "Price is required unless pricing is custom" });
  }
});

export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;

export const UpdateServiceSchema = z.object({
  title: title.optional(),
  description: description.optional(),
  price: price.nullable().optional(),
  priceType: z.enum(PriceTypeValues).optional(),
  serviceType: z.enum(ServiceTypeValues).optional(),
  estimatedDurationMins: z.number().min(15).max(480).optional(),
  queueLimit: z.number().int().min(1).max(10).optional(),
  paymentMethods: paymentMethods.optional(),
  categoryId: z.string().min(1).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>;

export const BookingScheduleSchema = z.object({
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "scheduledDate must be YYYY-MM-DD format").optional(),
  scheduledTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "scheduledTime must be HH:MM format").optional(),
});

export type BookingScheduleInput = z.infer<typeof BookingScheduleSchema>;
