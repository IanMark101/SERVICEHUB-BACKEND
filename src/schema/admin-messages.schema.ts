import { z } from 'zod';

export const AdminMessagesQuery = z.object({
  before: z.string().trim().min(1).max(150).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
