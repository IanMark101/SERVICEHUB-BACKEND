import { z } from 'zod';

export const GCashNumberSchema = z.string().trim().max(24)
  .transform(value => value.replace(/[\s-]/g, '').replace(/^\+63/, '0'))
  .pipe(z.string().regex(/^09\d{9}$/, 'Enter a Philippine GCash number, such as 09123456789 or +639123456789.'));

// A deliberate null removes the preference; omitted fields and owner IDs fail.
export const UpdateGCashNumberSchema = z.object({ gcashNumber: GCashNumberSchema.nullable() }).strict();
