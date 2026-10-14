import { prisma } from '../../lib/prisma';
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from '../account-lifecycle.service';
import { lockAuthenticationSession } from './session-lifecycle.service';
import { UpdateGCashNumberSchema } from '../../schema/gcash-number.schema';

const sessionExpired = () => Object.assign(new Error('Your session expired. Sign in again.'), { status: 401 });

export async function getOwnGCashNumber(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { gcashNumber: true, role: true, isActive: true, deactivatedAt: true, moderationStatus: true },
  });
  if (!user || user.role !== 'user' || !user.isActive || user.deactivatedAt || user.moderationStatus !== 'ACTIVE') {
    throw Object.assign(new Error('This account cannot manage a GCash number.'), { status: 403 });
  }
  return { gcashNumber: user.gcashNumber };
}

export async function updateOwnGCashNumber(userId: string, sessionId: string | undefined, input: unknown) {
  const { gcashNumber } = UpdateGCashNumberSchema.parse(input);
  if (!sessionId) throw sessionExpired();
  return prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, userId);
    await lockAuthenticationSession(tx, userId);
    await assertActiveMarketplaceAccount(tx, userId);
    const session = await tx.refreshToken.findUnique({ where: { id: sessionId }, select: { userId: true, expiresAt: true } });
    if (!session || session.userId !== userId || session.expiresAt <= new Date()) throw sessionExpired();
    // This is a private preference, not a verified wallet or payout destination.
    return tx.user.update({ where: { id: userId }, data: { gcashNumber }, select: { gcashNumber: true } });
  });
}
