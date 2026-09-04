import { prisma } from "../../lib/prisma";
import { recalculateQueue, notifyWaitlist } from "../queue.service";
import { applyCancellationTrust, applyServiceCompletionTrust } from "../trust.service";
import { safeEmit } from "../../lib/socket";
import { assertDistinctAccounts } from "../../utils/security";
import { sendMessage } from "../messages.service";
import { refundBookingPayment } from "../payment-refund.service";
// ── Hide / Dismiss Booking from User View ─────────────────────────────────────

export async function hideBookingService(bookingId: string, userId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId }
  });

  if (!booking) {
    const err = new Error("Booking not found") as any;
    err.status = 404;
    throw err;
  }

  if (booking.seekerId !== userId && booking.providerId !== userId) {
    const err = new Error("Access denied") as any;
    err.status = 403;
    throw err;
  }

  const isSeeker = booking.seekerId === userId;
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: isSeeker ? { hiddenBySeeker: true } : { hiddenByProvider: true }
  });

  // Emit engagement change to that user's socket so their UI updates immediately
  safeEmit(`user:${userId}`, "ENGAGEMENT_CHANGED", { bookingId, type: "hidden" });

  return { success: true, bookingId: updated.id };
}
