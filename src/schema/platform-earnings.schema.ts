import { z } from 'zod';

export const PlatformEarningsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  period: z.enum(['today', 'week', 'month', 'custom']).default('month'),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(['all', 'earned', 'held', 'pending', 'failed', 'refunded', 'review']).default('all'),
}).strict().superRefine((value, ctx) => {
  if (value.period === 'custom') {
    if (!value.from || !value.to) ctx.addIssue({ code: 'custom', message: 'Choose a start and end date.', path: ['from'] });
    else if (value.from > value.to || Date.parse(value.to) - Date.parse(value.from) > 366 * 86_400_000) {
      ctx.addIssue({ code: 'custom', message: 'Choose a date range of up to one year, with the start before the end.', path: ['to'] });
    }
  }
});
export type PlatformEarningsQuery = z.infer<typeof PlatformEarningsQuerySchema>;
