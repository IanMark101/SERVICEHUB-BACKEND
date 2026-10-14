import type { Prisma } from '@prisma/client';
import { safeEmit } from '../lib/socket';

type Content = Pick<Prisma.NotificationUncheckedCreateInput, 'title' | 'body' | 'link'>;
type BookingParticipants = { id: string; seekerId: string; providerId: string };

/** Store administrator alerts in the same transaction as the case. */
export async function recordAdminNotifications(tx: Prisma.TransactionClient, content: Content) {
  const admins = await tx.user.findMany({ where: { role: 'admin', isActive: true, moderationStatus: 'ACTIVE' }, select: { id: true } });
  if (admins.length) await tx.notification.createMany({ data: admins.map(admin => ({ userId: admin.id, ...content })) });
  return admins.map(admin => admin.id);
}

export function publishNotifications(userIds: readonly string[], title: string) {
  for (const userId of new Set(userIds)) safeEmit(`user:${userId}`, 'notification', { title });
}

export function bookingCancellationNotifications(booking: BookingParticipants) {
  return [
    { userId: booking.seekerId, link: `/seeker/seeker-activity?tab=canceled&booking=${booking.id}` },
    { userId: booking.providerId, link: `/provider/provider-activity?tab=canceled&booking=${booking.id}` },
  ].map(notice => ({ ...notice, id: `booking-cancelled:${booking.id}:${notice.userId}`, title: 'Booking cancelled', body: 'The booking has been cancelled.' }));
}

/** Recognize the old randomly identified alerts as well as current alerts.
 * Call under the booking lifecycle lock when inserting repairs. */
export async function missingBookingCancellationNotifications(tx: Pick<Prisma.TransactionClient, 'notification'>, booking: BookingParticipants) {
  const expected = bookingCancellationNotifications(booking);
  const existing = await tx.notification.findMany({ where: { OR: [
    { id: { in: expected.map(notice => notice.id) } },
    { userId: { in: expected.map(notice => notice.userId) }, title: { in: ['Booking cancelled', 'Booking canceled'] }, link: { in: expected.map(notice => notice.link) } },
  ] }, select: { userId: true, link: true } });
  return expected.filter(notice => !existing.some(row => row.userId === notice.userId && row.link === notice.link));
}
