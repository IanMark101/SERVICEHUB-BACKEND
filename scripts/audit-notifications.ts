import { prisma } from '../src/lib/prisma';
import { lockBookingLifecycle } from '../src/services/booking-lifecycle.service';
import { missingBookingCancellationNotifications } from '../src/services/notifications.service';

/** Read-only by default. --apply inserts only missing cancellation alerts;
 * it never changes bookings, messages, payment state, or existing alerts. */
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Use --apply to repair, or no arguments for a read-only audit');
  const apply = args.includes('--apply');
  const counts = { mode: apply ? 'repair' : 'audit', scannedCancelledBookings: 0, missingSeekerAlerts: 0, missingProviderAlerts: 0, createdAlerts: 0, invalidParticipants: 0 };
  let cursor: string | undefined;
  for (;;) {
    const bookings = await prisma.booking.findMany({ where: { status: 'CANCELED' }, select: { id: true, seekerId: true, providerId: true },
      orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!bookings.length) break;
    for (const booking of bookings) {
      counts.scannedCancelledBookings++;
      if (booking.seekerId === booking.providerId) { counts.invalidParticipants++; continue; }
      const result = apply ? await prisma.$transaction(async tx => {
        await lockBookingLifecycle(tx, booking.id);
        const current = await tx.booking.findUnique({ where: { id: booking.id }, select: { id: true, status: true, seekerId: true, providerId: true } });
        if (!current || current.status !== 'CANCELED') return { missing: [], created: 0 };
        const missing = await missingBookingCancellationNotifications(tx, current);
        const inserted = missing.length ? await tx.notification.createMany({ data: missing, skipDuplicates: true }) : { count: 0 };
        return { missing, created: inserted.count };
      }) : { missing: await missingBookingCancellationNotifications(prisma, booking), created: 0 };
      counts.missingSeekerAlerts += result.missing.filter(notice => notice.userId === booking.seekerId).length;
      counts.missingProviderAlerts += result.missing.filter(notice => notice.userId === booking.providerId).length;
      counts.createdAlerts += result.created;
    }
    cursor = bookings.at(-1)?.id;
  }
  // Summary only: no names, contact details, notification bodies, or credentials.
  console.log(JSON.stringify(counts, null, 2));
}
main().catch(error => {
  console.error('Notification audit failed.', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'Check database availability and the command arguments.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
