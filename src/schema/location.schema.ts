import { z } from 'zod';

export const LocationPointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  label: z.string().trim().min(2).max(160),
}).strict();
export const JobLocationSchema = LocationPointSchema.extend({
  address: z.string().trim().max(500).optional(),
}).strict();
export type LocationPoint = z.infer<typeof LocationPointSchema>;
export type JobLocation = z.infer<typeof JobLocationSchema>;
export const TransportationFeeSchema = z.number().finite().min(0).max(5_000)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 'Use at most two decimal places');
export const CoverageRadiusSchema = z.number().finite().min(1).max(30);
export const NearbyQuerySchema = z.object({
  latitude: z.coerce.number().finite().min(-90).max(90),
  longitude: z.coerce.number().finite().min(-180).max(180),
  radiusKm: z.coerce.number().finite().min(1).max(30),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(6),
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  filter: z.enum(['all', 'available', 'rated', 'low-queue', 'urgent', 'high-budget', 'few-offers']).default('all'),
}).strict();
export type NearbyQuery = z.infer<typeof NearbyQuerySchema>;
