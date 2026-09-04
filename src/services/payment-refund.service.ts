import { prisma } from "../lib/prisma";
import { createRefund, getPaymentIntent } from "./paymongo.service";

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
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { queue: true },
  });
  if (!booking) throw httpError("Booking not found", 404);
  if (!booking.queue) throw httpError("This booking has no online payment to refund", 409);

  const existing = await prisma.paymentRefund.findUnique({ where: { bookingId } });
  if (existing?.paymongoRefundId) {
    return {
      refundId: existing.paymongoRefundId,
      status: existing.status,
      amount: Number(existing.amount),
      alreadySubmitted: true,
    };
  }
  if (existing?.status === "PROCESSING") {
    throw httpError("A refund for this booking is already being processed", 409);
  }
  if (!["PAID_HELD", "FROZEN_HELD"].includes(booking.paymentStatus)) {
    throw httpError("Only a held online payment can be refunded", 409);
  }

  const intent = await getPaymentIntent(booking.queue.paymentId);
  const paymentId = booking.queue.paymongoPaymentId || intent.paymentId;
  if (!paymentId || intent.status !== "succeeded") {
    throw httpError("PayMongo did not confirm a refundable successful payment", 409);
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.paymentRefund.findUnique({ where: { bookingId } });
    if (current?.paymongoRefundId || current?.status === "PROCESSING") {
      throw httpError("A refund for this booking has already been submitted or is processing", 409);
    }
    if (current) {
      await tx.paymentRefund.update({
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
      await tx.paymentRefund.create({
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
  });

  let gatewayRefund: Awaited<ReturnType<typeof createRefund>>;
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

  await prisma.$transaction(async (tx) => {
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
      data: { status: "CANCELED", paymentStatus: "REFUNDED" },
    });
    await tx.queue.update({
      where: { id: booking.queue!.id },
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
  });

  return {
    refundId: gatewayRefund.id,
    status: gatewayRefund.status,
    amount: intent.amount,
    alreadySubmitted: false,
  };
}
