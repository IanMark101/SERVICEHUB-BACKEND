import { z } from 'zod';
import { securityHistoryCutoff } from '../services/security-history.service';

export const AuditHistoryQuery = z.object({
  kind: z.enum(['admin', 'security']).default('admin'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).default(''),
  action: z.string().trim().max(50).default(''),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine(value => !value.from || !value.to || value.from <= value.to, { message: 'Start date must be on or before end date', path: ['to'] });

export function auditDateRange(query: z.infer<typeof AuditHistoryQuery>, now = new Date()) {
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : null;
  const cutoff = query.kind === 'security' ? securityHistoryCutoff(now) : null;
  return {
    ...((from || cutoff) ? { gte: from && (!cutoff || from > cutoff) ? from : cutoff! } : {}),
    ...(query.to ? { lt: new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
  };
}
