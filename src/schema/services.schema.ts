import { LocationPointSchema, CoverageRadiusSchema, TransportationFeeSchema } from './location.schema';
import { z } from "zod";

export const PriceTypeValues = [
  "FIXED", "PER_HOUR", "PER_DAY", "PER_PROJECT",
] as const;
export type PriceTypeValue = typeof PriceTypeValues[number];

export const ServiceTypeValues = ["ONE_TIME"] as const;
export type ServiceTypeValue = typeof ServiceTypeValues[number];

const title = z.string()
  .trim()
  .toUpperCase()
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
  cash: z.boolean().default(false),
}).strict().refine(
  (methods) => methods.gcash || methods.cash,
  "At least one payment method must be selected",
);

export const CreateServiceSchema = z.object({
  categoryId: z.string().min(1, "Invalid category"),
  title,
  description,
  price,
  serviceLocation: LocationPointSchema,
  coverageRadiusKm: CoverageRadiusSchema.nullable().optional(),
  transportationFee: TransportationFeeSchema.nullable().optional(),
  priceType: z.enum(PriceTypeValues).default("FIXED"),
  serviceType: z.enum(ServiceTypeValues).default("ONE_TIME"),
  estimatedDurationMins: z.number().min(15).max(480),
  // Legacy listing column; provider-wide onlineQueueLimit is operational.
  queueLimit: z.number().int().min(1).max(10).default(3),
  paymentMethods,
});

export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;

export const UpdateServiceSchema = z.object({
  title: title.optional(),
  description: description.optional(),
  price: price.optional(),
  serviceLocation: LocationPointSchema.optional(),
  coverageRadiusKm: CoverageRadiusSchema.nullable().optional(),
  transportationFee: TransportationFeeSchema.nullable().optional(),
  priceType: z.enum(PriceTypeValues).optional(),
  serviceType: z.enum(ServiceTypeValues).optional(),
  estimatedDurationMins: z.number().min(15).max(480).optional(),
  queueLimit: z.number().int().min(1).max(10).optional(),
  paymentMethods: paymentMethods.optional(),
  categoryId: z.string().min(1).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>;
