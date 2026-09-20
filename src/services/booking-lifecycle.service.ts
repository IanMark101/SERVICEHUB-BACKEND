import type { Prisma } from "@prisma/client";

/**
 * Global coordination point for every mutation of an existing Booking.
 *
 * Lock ordering is always:
 *   booking lifecycle -> provider/request (when needed) -> service queue.
 * The lock is transaction-scoped, so callers must re-read the Booking after
 * acquiring it and validate the fresh state before writing.
 */
export async function lockBookingLifecycle(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking-lifecycle:${bookingId}`}))`;
}

export async function assertNoRefundInProgress(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  const refund = await tx.paymentRefund.findUnique({
    where: { bookingId },
    select: { status: true },
  });
  if (refund?.status === "PROCESSING") {
    const error = new Error("A refund for this booking is currently being processed") as Error & {
      status?: number;
      code?: string;
    };
    error.status = 409;
    error.code = "BOOKING_REFUND_IN_PROGRESS";
    throw error;
  }
}
