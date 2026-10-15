import type { Prisma } from '@prisma/client';
import { GCashNumberSchema } from '../schema/gcash-number.schema';

/** Call while holding the owner's account lifecycle lock, as number edits do. */
export async function assertListingGCashNumber(tx: Prisma.TransactionClient, userId: string, methods: unknown) {
  if (!methods || typeof methods !== 'object' || !('gcash' in methods) || methods.gcash !== true) return;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { gcashNumber: true } });
  if (!GCashNumberSchema.safeParse(user?.gcashNumber).success) {
    throw Object.assign(new Error('Add a valid GCash number before publishing or saving a listing with GCash selected. You can choose Cash only instead.'), { status: 422, code: 'GCASH_NUMBER_REQUIRED', field: 'gcashNumber' });
  }
}
