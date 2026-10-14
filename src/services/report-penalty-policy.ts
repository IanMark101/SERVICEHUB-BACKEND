import type { Prisma } from '@prisma/client';
import { lockAccountLifecycle } from './account-lifecycle.service';

export type ReportPenalty = 'none' | 'warn' | 'trust_deduct' | 'suspend' | 'ban';
type Account = { id: string; role: string; isActive: boolean; deactivatedAt: Date | null; moderationStatus: string };

export function allowedReportPenalties(account: Account | null, adminId?: string): ReportPenalty[] {
  if (!account || account.id === adminId || account.role !== 'user' || !account.isActive || account.deactivatedAt) return ['none'];
  return ['none', 'warn', 'trust_deduct', ...(account.moderationStatus === 'ACTIVE' ? ['suspend' as const] : []), ...(account.moderationStatus !== 'BANNED' ? ['ban' as const] : [])];
}

// The caller holds the booking lock before acquiring the account lock.
export async function checkReportPenalty(tx: Prisma.TransactionClient, userId: string, adminId: string, penalty: ReportPenalty, options: { resuming?: boolean; canceledBookingId?: string } = {}) {
  if (penalty === 'none') return { penalty, note: null };
  await lockAccountLifecycle(tx, userId);
  const account = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true, deactivatedAt: true, moderationStatus: true } });
  if (!allowedReportPenalties(account, adminId).includes(penalty)) {
    const note = 'The account changed before finalization. Its existing access restrictions were preserved; the requested account penalty was not applied.';
    // An already claimed payment decision must remain recoverable if another
    // admin bans the account or the account is deactivated in the meantime.
    if (options.resuming) return { penalty: 'none' as const, note };
    throw Object.assign(new Error('This account cannot receive that penalty. Refresh the case and review its current account status.'), { status: 409, code: 'INVALID_REPORT_PENALTY' });
  }
  if (penalty === 'suspend') {
    const blockers = await tx.booking.count({ where: { providerId: userId, started: false, status: { in: ['PENDING_APPROVAL', 'WAITING', 'ACCEPTED'] }, ...(options.canceledBookingId && { id: { not: options.canceledBookingId } }) } });
    if (blockers > 0) throw Object.assign(new Error(`Resolve or cancel the provider's ${blockers} unstarted booking(s) before suspension.`), { status: 409, code: 'SUSPENSION_BOOKINGS_BLOCKED' });
  }
  return { penalty, note: null };
}
