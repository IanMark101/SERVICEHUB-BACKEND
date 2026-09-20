import { prisma } from "../lib/prisma";
import { createRefund, getPaymentIntent } from "./paymongo.service";
import {
  emitWaitlistNotification,
  lockServiceQueue,
  notifyWaitlistInTransaction,
  recalculateQueueInTransaction,
} from "./queue.service";
import { lockBookingLifecycle } from "./booking-lifecycle.service";

type RefundResult = {
  refundId: string;
  status: string;
  amount: number;
  alreadySubmitted: boolean;
};

function httpError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

/**
 * Submits one full PayMongo refund and only then marks the local booking as
 * refunded. PaymentRefund.bookingId is unique, which provides the durable
 * idempotency guard across retries and concurrent cancellation requests.
 */
export async function refundBookingPayment(
  bookingId: string,
  requestedById: string,
  reason: string,
): Promise<RefundResult> {
  const initialBooking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { queue: true },
  });
  if (!initialBooking) throw httpError("Booking not found", 404);
  if (!initialBooking.queue) throw httpError("This booking has no online payment to refund", 409);

  const existing = await prisma.paymentRefund.findUnique({ where: { bookingId } });
  if (existing?.paymongoRefundId && initialBooking.status === "CANCELED" && initialBooking.paymentStatus === "REFUNDED") {
    return {
      refundId: existing.paymongoRefundId,
      status: existing.status,
      amount: Number(existing.amount),
      alreadySubmitted: true,
    };
  }
  if (!existing?.paymongoRefundId && !["PAID_HELD", "FROZEN_HELD"].includes(initialBooking.paymentStatus)) {
    throw httpError("Only a held online payment can be refunded", 409);
  }

  const intent = await getPaymentIntent(initialBooking.queue.paymentId);
  const paymentId = initialBooking.queue.paymongoPaymentId || intent.paymentId;
  if (!paymentId || intent.status !== "succeeded") {
    throw httpError("PayMongo did not confirm a refundable successful payment", 409);
  }

  const reservation = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, bookingId);
    const fresh = await tx.booking.findUnique({ where: { id: bookingId }, include: { queue: true, completedService: true } });
    if (!fresh) throw httpError("Booking not found", 404);
    if (fresh.completedService || fresh.status === "COMPLETED" || fresh.paymentStatus === "RELEASED" || fresh.paymentStatus === "CASH_CONFIRMED") {
      throw httpError("A completed booking cannot be refunded", 409);
    }
    const current = await tx.paymentRefund.findUnique({ where: { bookingId } });
    if (current?.paymongoRefundId) {
      return { resumed: true, refund: current, booking: fresh };
    }
    if (current?.status === "PROCESSING") {
      // The provider call is idempotent by booking ID. Retrying a stranded
      // PROCESSING reservation safely resumes the same external operation.
      return { resumed: false, refund: current, booking: fresh };
    }
    if (!["PAID_HELD", "FROZEN_HELD"].includes(fresh.paymentStatus)) {
      throw httpError("Only a held online payment can be refunded", 409);
    }
    let refundRecord;
    if (current) {
      refundRecord = await tx.paymentRefund.update({
        where: { bookingId },
        data: {
          paymentId,
          amount: intent.amount,
          status: "PROCESSING",
          reason,
          requestedById,
          failureReason: null,
        },
      });
    } else {
      refundRecord = await tx.paymentRefund.create({
        data: {
          bookingId,
          paymentId,
          amount: intent.amount,
          status: "PROCESSING",
          reason,
          requestedById,
        },
      });
    }
    return { resumed: false, refund: refundRecord, booking: fresh };
  });

  let gatewayRefund: Awaited<ReturnType<typeof createRefund>> | { id: string; status: string };
  if (reservation.resumed && reservation.refund.paymongoRefundId) {
    gatewayRefund = { id: reservation.refund.paymongoRefundId, status: reservation.refund.status };
  } else {
    try {
      gatewayRefund = await createRefund({
        paymentId,
        amount: intent.amount,
        reason: "requested_by_customer",
        idempotencyKey: `servicehub-booking-refund-${bookingId}`,
      });
    } catch (error) {
      await prisma.paymentRefund.update({
        where: { bookingId },
        data: {
          status: "FAILED",
          failureReason: error instanceof Error ? error.message.slice(0, 1_000) : "PayMongo refund request failed",
        },
      });
      throw error;
    }
  }

  const waitlistNotification = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, bookingId);
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: { queue: true, completedService: true, offer: { select: { requestId: true } } } });
    if (!booking || !booking.queue) throw httpError("Booking or online queue entry not found", 404);
    if (booking.status === "CANCELED" && booking.paymentStatus === "REFUNDED") return null;
    if (booking.completedService || booking.status === "COMPLETED" || !["PAID_HELD", "FROZEN_HELD"].includes(booking.paymentStatus)) {
      throw httpError("Booking state changed before the refund could be finalized", 409);
    }
    const refundRecord = await tx.paymentRefund.findUnique({ where: { bookingId } });
    if (!refundRecord || (!reservation.resumed && refundRecord.status !== "PROCESSING")) {
      throw httpError("Refund reservation is no longer valid", 409);
    }
    await lockServiceQueue(tx, booking.queue.serviceId);
    await tx.paymentRefund.update({
      where: { bookingId },
      data: {
        status: gatewayRefund.status.toUpperCase(),
        paymongoRefundId: gatewayRefund.id,
        failureReason: null,
      },
    });
    await tx.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELED", paymentStatus: "REFUNDED", statusBeforeDispute: null },
    });
    await tx.queue.update({
      where: { id: booking.queue.id },
      data: { status: "CANCELLED", paymentStatus: "REFUNDED" },
    });
    const transaction = await tx.transaction.findFirst({
      where: { relatedBookingId: bookingId, type: "REFUND", paymongoRefId: gatewayRefund.id },
    });
    if (!transaction) {
      await tx.transaction.create({
        data: {
          walletOwnerId: booking.seekerId,
          type: "REFUND",
          amount: intent.amount,
          status: "completed",
          relatedBookingId: bookingId,
          paymongoRefId: gatewayRefund.id,
          description: reason,
          settlementSource: "ONLINE_LEDGER",
          idempotencyKey: `booking-refund:${bookingId}`,
        },
      });
    }
    if (booking.offer?.requestId) {
      await tx.serviceRequest.updateMany({ where: { id: booking.offer.requestId }, data: { status: "CANCELED" } });
    }
    await recalculateQueueInTransaction(tx, booking.queue.serviceId);
    return notifyWaitlistInTransaction(tx, booking.queue.serviceId);
  });
  emitWaitlistNotification(waitlistNotification);

  return {
    refundId: gatewayRefund.id,
    status: gatewayRefund.status,
    amount: intent.amount,
    alreadySubmitted: reservation.resumed,
  };
}
