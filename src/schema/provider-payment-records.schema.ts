import { z } from 'zod';

export const ProviderPaymentRecordsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(8),
  date: z.iso.date().optional(),
  status: z.enum(['all', 'completed', 'refunded', 'cancelled']).default('all'),
  booking: z.string().trim().min(1).max(128).optional(),
}).strict();

export type ProviderPaymentRecordsQuery = z.infer<typeof ProviderPaymentRecordsQuerySchema>;
