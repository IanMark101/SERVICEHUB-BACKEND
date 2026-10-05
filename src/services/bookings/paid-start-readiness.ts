import type { BookingStatus, PaymentStatus, QueueStatus } from "@prisma/client";

export function paidStartBlockReason(input: {
  bookingStatus: BookingStatus;
  bookingStarted: boolean;
  bookingPaymentStatus: PaymentStatus;
  queueStatus: QueueStatus;
  queuePaymentStatus: PaymentStatus;
}): string | null {
  if (input.queueStatus !== "WAITING") return "This booking is no longer waiting in the paid queue.";
  if (input.bookingStarted) return "This job has already started.";
  // Older captured bookings used WAITING for the booking as well as its queue
  // row. They are startable only with the same confirmed payment as ACCEPTED.
  if (input.bookingStatus !== "ACCEPTED" && input.bookingStatus !== "WAITING") {
    return ["DISPUTED", "UNDER_REVIEW"].includes(input.bookingStatus)
      ? "This booking is on hold for review. Resolve the case before starting work."
      : "This booking is not accepted for work. Open its details for the current status.";
  }
  if (input.bookingPaymentStatus !== "PAID_HELD" || input.queuePaymentStatus !== "PAID_HELD") {
    return "The GCash payment is not confirmed for this booking. Do not start work yet.";
  }
  return null;
}
