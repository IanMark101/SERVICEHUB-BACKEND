import { z } from 'zod';

export const PlaceSuggestionQuerySchema = z.object({
  q: z.string().trim().min(3).max(80),
  latitude: z.coerce.number().finite().min(-90).max(90).optional(),
  longitude: z.coerce.number().finite().min(-180).max(180).optional(),
}).strict().refine(value => (value.latitude === undefined) === (value.longitude === undefined), 'Provide both search coordinates.');
export type PlaceSuggestionQuery = z.infer<typeof PlaceSuggestionQuerySchema>;

export const LocationPointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  label: z.string().trim().min(2).max(160),
}).strict();
// A discovery point always has coordinates. A private booking address may be
// written directions instead; never invent an exact job pin from a base area.
export const JobLocationSchema = LocationPointSchema.partial({ latitude: true, longitude: true }).extend({
  address: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  const hasPoint = value.latitude !== undefined && value.longitude !== undefined;
  if ((value.latitude !== undefined) !== (value.longitude !== undefined)) context.addIssue({ code: 'custom', path: ['latitude'], message: 'Provide both map coordinates.' });
  if (!hasPoint && (value.address?.length ?? 0) < 5) context.addIssue({ code: 'custom', path: ['address'], message: 'Enter the job address or directions, or choose a job pin.' });
});
export type LocationPoint = z.infer<typeof LocationPointSchema>;
export type JobLocation = z.infer<typeof JobLocationSchema>;
export const ServiceLocationModeSchema = z.enum(['PROVIDER_VISITS', 'SEEKER_VISITS', 'BOTH', 'REMOTE']);
export const BookingLocationModeSchema = z.enum(['PROVIDER_VISITS', 'SEEKER_VISITS', 'REMOTE']);
export type ServiceLocationMode = z.infer<typeof ServiceLocationModeSchema>;
export type BookingLocationMode = z.infer<typeof BookingLocationModeSchema>;
export const TransportationFeeSchema = z.number().finite().min(0).max(5_000)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 'Use at most two decimal places');
export const CoverageRadiusSchema = z.number().finite().min(1).max(30);
const SearchRadiusQuerySchema = z.union([
  z.number(),
  z.string().trim().regex(/^(?:\d+(?:\.\d+)?|\.\d+)$/, 'Enter a radius in kilometers.'),
]).transform(value => Number(value)).pipe(z.number().finite()
  .min(0.5, 'Enter a radius between 0.5 and 30 km.')
  .max(30, 'Enter a radius between 0.5 and 30 km.')
  .multipleOf(0.1, 'Use increments of 0.1 km.'));
export const NearbyQuerySchema = z.object({
  latitude: z.coerce.number().finite().min(-90).max(90),
  longitude: z.coerce.number().finite().min(-180).max(180),
  radiusKm: SearchRadiusQuerySchema,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(6),
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(),
  filter: z.enum(['all', 'available', 'rated', 'low-queue', 'urgent', 'high-budget', 'few-offers']).default('all'),
}).strict();
export type NearbyQuery = z.infer<typeof NearbyQuerySchema>;
