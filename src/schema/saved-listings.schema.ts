import { z } from 'zod';

export const SavedListingTypeSchema = z.enum(['SERVICE_LISTING', 'SERVICE_REQUEST']);
export type SavedListingType = z.infer<typeof SavedListingTypeSchema>;
const id = z.string().trim().min(1).max(150);
export const SavedListingParamsSchema = z.object({ contentType: SavedListingTypeSchema, listingId: id });
export const SavedListingsQuerySchema = z.object({
  contentType: SavedListingTypeSchema,
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(12),
});
export const SavedListingStatusSchema = z.object({
  contentType: SavedListingTypeSchema,
  ids: z.string().transform(value => [...new Set(value.split(','))]).pipe(z.array(id).min(1).max(100)),
});
