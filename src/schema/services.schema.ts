import { LocationPointSchema, CoverageRadiusSchema, TransportationFeeSchema, ServiceLocationModeSchema } from './location.schema';
import { z } from "zod";
import { ListingPhotoIdsSchema } from './listing-photos.schema';

export const PriceTypeValues = [
  "FIXED", "PER_HOUR", "PER_DAY", "PER_PROJECT", "BY_AGREEMENT",
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
  photoIds: ListingPhotoIdsSchema.optional(),
  categoryId: z.string().min(1, "Invalid category"),
  title,
  description,
  price: price.nullable().optional(),
  serviceLocation: LocationPointSchema.nullable().optional(),
  publicMapPin: z.boolean().default(false),
  serviceLocationMode: ServiceLocationModeSchema.default('PROVIDER_VISITS'),
  venueAddress: z.string().trim().max(500).nullable().optional(),
  coverageRadiusKm: CoverageRadiusSchema.nullable().optional(),
  transportationFee: TransportationFeeSchema.nullable().optional(),
  priceType: z.enum(PriceTypeValues).default("FIXED"),
  serviceType: z.enum(ServiceTypeValues).default("ONE_TIME"),
  estimatedDurationMins: z.number().min(15).max(480),
  // Legacy listing column; provider-wide onlineQueueLimit is operational.
  queueLimit: z.number().int().min(1).max(10).default(3),
  paymentMethods,
}).superRefine((value, context) => {
  if (['SEEKER_VISITS', 'BOTH'].includes(value.serviceLocationMode) && (value.venueAddress?.length ?? 0) < 5) context.addIssue({ code: 'custom', path: ['venueAddress'], message: 'Enter your workplace address or directions for seekers who visit you.' });
  if (value.serviceLocationMode !== 'REMOTE' && !value.serviceLocation) context.addIssue({ code:'custom',path:['serviceLocation'],message:'Choose your base area or shop location for an in-person service.' });
  if (value.priceType === 'BY_AGREEMENT' ? value.price != null : value.price == null) {
    context.addIssue({ code: 'custom', path: ['price'], message: value.priceType === 'BY_AGREEMENT' ? 'Leave the price blank for Price by agreement.' : 'Enter the service price or choose Price by agreement.' });
  }
}).transform(value => ({ ...value, price: value.priceType === 'BY_AGREEMENT' ? null : value.price! }));

export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;

export const UpdateServiceSchema = z.object({
  photoIds: ListingPhotoIdsSchema.optional(),
  title: title.optional(),
  description: description.optional(),
  price: price.nullable().optional(),
  serviceLocation: LocationPointSchema.nullable().optional(),
  publicMapPin: z.boolean().optional(),
  serviceLocationMode: ServiceLocationModeSchema.optional(),
  venueAddress: z.string().trim().max(500).nullable().optional(),
  coverageRadiusKm: CoverageRadiusSchema.nullable().optional(),
  transportationFee: TransportationFeeSchema.nullable().optional(),
  priceType: z.enum(PriceTypeValues).optional(),
  serviceType: z.enum(ServiceTypeValues).optional(),
  estimatedDurationMins: z.number().min(15).max(480).optional(),
  queueLimit: z.number().int().min(1).max(10).optional(),
  paymentMethods: paymentMethods.optional(),
  categoryId: z.string().min(1).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required").superRefine((value, context) => {
  if (value.priceType === 'BY_AGREEMENT' && value.price != null) context.addIssue({ code: 'custom', path: ['price'], message: 'Leave the price blank for Price by agreement.' });
  if (value.priceType && value.priceType !== 'BY_AGREEMENT' && value.price === null) context.addIssue({ code: 'custom', path: ['price'], message: 'Enter a price for this pricing choice.' });
});

export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>;
