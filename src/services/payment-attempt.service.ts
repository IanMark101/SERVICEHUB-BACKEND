import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import {
  attachPaymentMethod,
  createPaymentIntent,
  createPaymentMethod,
  createRefund,
} from "./paymongo.service";
import { recalculateQueueInTransaction } from "./queue.service";

const ATTEMPT_TTL_MS = 15 * 60 * 1000;
type OnlineMethod = "gcash" | "paymaya" | "card";

function httpError(message: string, status: number, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

function displayMethod(method: string) {
  return ({ gcash: "GCash", paymaya: "Maya", card: "Card" } as Record<string, string>)[method] || method;
}

async function releaseOfferHold(offerId: string | null, tx: Prisma.TransactionClient) {
  if (!offerId) return;
  const offer = await tx.offer.findUnique({ where: { id: offerId }, select: { requestId: true, status: true } });
  if (!offer || offer.status !== "PENDING_PAYMENT") return;
  await tx.offer.update({
    where: { id: offerId },
    data: { status: "PENDING", paymentHoldExpiresAt: null },
  });
  await tx.serviceRequest.updateMany({
    where: { id: offer.requestId, status: "PAYMENT_PENDING" },
    data: { status: "OPEN" },
  });
}

export async function initiateOnlinePayment(params: {
  seekerId: string;
  serviceId: string;
  offerId?: string;
  paymentMethod: OnlineMethod;
}) {
  if (params.paymentMethod === "card") {
    throw httpError("Card checkout is not available yet. Choose an accepted e-wallet or on-site cash.", 409, "CARD_CHECKOUT_UNAVAILABLE");
  }
  if (!env.PAYMONGO_PUBLIC_KEY || !env.PAYMONGO_SECRET_KEY || !env.PAYMONGO_WEBHOOK_SECRET) {
    throw httpError("Online payment is unavailable until PayMongo Test Mode and its webhook are fully configured", 503, "PAYMENT_NOT_CONFIGURED");
  }
  const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MS);

  const prepared = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${params.seekerId}:${params.serviceId}:${params.offerId || "direct"}`}))`;

    const stale = await tx.paymentAttempt.findMany({
      where: {
        seekerId: params.seekerId,
        serviceId: params.serviceId,
        offerId: params.offerId || null,
        status: "PENDING",
        expiresAt: { lte: new Date() },
      },
      select: { id: true, offerId: true },
    });
    for (const attempt of stale) {
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "EXPIRED" } });
      await releaseOfferHold(attempt.offerId, tx);
    }

    const existing = await tx.paymentAttempt.findFirst({
      where: {
        seekerId: params.seekerId,
        serviceId: params.serviceId,
        offerId: params.offerId || null,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
    });
    if (existing) return { attempt: existing, reused: true };

    const service = await tx.service.findUnique({
      where: { id: params.serviceId },
      select: {
        id: true,
        title: true,
        providerId: true,
        categoryId: true,
        price: true,
        priceType: true,
        serviceType: true,
        paymentMethods: true,
        status: true,
        isAvailable: true,
        queueLimit: true,
        provider: {
          select: { isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true },
        },
      },
    });
    if (!service) throw httpError("Service not found", 404);
    if (service.providerId === params.seekerId) throw httpError("You cannot book your own service listing", 403, "SELF_TRANSACTION_NOT_ALLOWED");
    if (!params.offerId && service.priceType !== "FIXED") {
      throw httpError("Direct online payment is available only for fixed-price listings", 400, "FIXED_PRICE_REQUIRED");
    }
    if (service.serviceType !== "ONE_TIME") {
      throw httpError("Online queue payment is available only for one-time services", 400, "ONE_TIME_SERVICE_REQUIRED");
    }
    if (service.status !== "ACTIVE" || !service.isAvailable) throw httpError("This service is not available", 409);
    if (!service.provider.isActive || service.provider.moderationStatus !== "ACTIVE" || !service.provider.emailVerified || service.provider.verificationStatus !== "APPROVED") {
      throw httpError("The provider is not currently eligible to accept a new booking", 409, "PROVIDER_UNAVAILABLE");
    }

    const existingBooking = await tx.booking.findFirst({
      where: {
        seekerId: params.seekerId,
        serviceId: service.id,
        status: { in: ["PENDING_APPROVAL", "ACCEPTED", "WAITING", "ONGOING", "AWAITING_CONFIRMATION", "DISPUTED"] },
      },
      select: { id: true },
    });
    if (existingBooking) throw httpError("You already have an active booking for this service", 409, "ACTIVE_BOOKING_EXISTS");

    const methods = service.paymentMethods as { gcash?: boolean; maya?: boolean; card?: boolean };
    const accepted = params.paymentMethod === "gcash" ? methods?.gcash : params.paymentMethod === "paymaya" ? methods?.maya : methods?.card;
    if (!accepted) throw httpError("This payment method is not accepted for the service", 400);

    // Prisma's PostgreSQL adapter uses one connection for this transaction;
    // execute transaction-client queries serially instead of overlapping them.
    const ongoingCount = await tx.booking.count({ where: { serviceId: service.id, status: "ONGOING" } });
    const waitingCount = await tx.queue.count({ where: { serviceId: service.id, status: "WAITING" } });
    if (ongoingCount + waitingCount >= service.queueLimit) throw httpError("The service queue is full", 409, "QUEUE_FULL");

    let amount = Number(service.price);
    let offerRequestId: string | undefined;
    if (params.offerId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offer-selection:${params.offerId}`}))`;
      const offer = await tx.offer.findUnique({
        where: { id: params.offerId },
        include: { request: { select: { id: true, seekerId: true, categoryId: true, status: true } } },
      });
      if (!offer || offer.status !== "PENDING" || offer.request.status !== "OPEN" || offer.request.seekerId !== params.seekerId || offer.providerId !== service.providerId || offer.serviceId !== service.id || offer.request.categoryId !== service.categoryId) {
        throw httpError("The offer is no longer payable or does not match this listing", 409, "OFFER_NOT_PAYABLE");
      }
      amount = Number(offer.offeredPrice);
      offerRequestId = offer.requestId;
      await tx.offer.update({
        where: { id: offer.id },
        data: { status: "PENDING_PAYMENT", paymentHoldExpiresAt: expiresAt },
      });
      await tx.serviceRequest.update({ where: { id: offer.requestId }, data: { status: "PAYMENT_PENDING" } });
    }

    if (!Number.isFinite(amount) || amount <= 0) throw httpError("The booking amount is invalid", 400);
    const idempotencyKey = `servicehub-attempt-${crypto.randomUUID()}`;
    const attempt = await tx.paymentAttempt.create({
      data: {
        idempotencyKey,
        seekerId: params.seekerId,
        providerId: service.providerId,
        serviceId: service.id,
        offerId: params.offerId || null,
        amount,
        paymentMethod: params.paymentMethod,
        expiresAt,
      },
    });
    return { attempt, reused: false, serviceTitle: service.title, offerRequestId };
  });

  if (prepared.reused && prepared.attempt.redirectUrl) return prepared.attempt;
  if (prepared.reused && prepared.attempt.providerIntentId) return prepared.attempt;

  try {
    const attempt = prepared.attempt;
    const intent = await createPaymentIntent({
      amount: Number(attempt.amount),
      description: `ServiceHub Cordova booking for ${attempt.serviceId}`,
      paymentMethod: attempt.paymentMethod as OnlineMethod,
      idempotencyKey: attempt.idempotencyKey,
      metadata: {
        servicehub_attempt_id: attempt.id,
        servicehub_seeker_id: attempt.seekerId,
        servicehub_service_id: attempt.serviceId,
        servicehub_offer_id: attempt.offerId || "",
        servicehub_expected_amount: Number(attempt.amount).toFixed(2),
        servicehub_payment_method: attempt.paymentMethod,
      },
    });
    const methodId = await createPaymentMethod(attempt.paymentMethod);
    const returnUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/seeker/seeker-activity`;
    const attached = await attachPaymentMethod({
      paymentIntentId: intent.id,
      paymentMethodId: methodId,
      clientKey: intent.clientKey,
      returnUrl,
    });
    const redirectUrl = attached.status === "awaiting_next_action" && attached.nextAction?.type === "redirect"
      ? attached.nextAction.redirect?.url
      : undefined;
    return prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { providerIntentId: intent.id, providerClientKey: intent.clientKey, redirectUrl },
    });
  } catch (error: any) {
    await prisma.$transaction(async (tx) => {
      await tx.paymentAttempt.update({
        where: { id: prepared.attempt.id },
        data: { status: "FAILED", failureReason: error?.code || "PAYMENT_PROVIDER_ERROR" },
      });
      await releaseOfferHold(prepared.attempt.offerId, tx);
    });
    throw error;
  }
}

export async function getPaymentAttemptStatus(seekerId: string, paymentIntentId: string) {
  const attempt = await prisma.paymentAttempt.findFirst({
    where: { seekerId, providerIntentId: paymentIntentId },
    select: { id: true, status: true, failureReason: true, expiresAt: true },
  });
  if (!attempt) throw httpError("Payment attempt not found", 404);
  return attempt;
}

export async function markPaymentAttemptFailed(paymentIntentId: string, reason: string) {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { providerIntentId: paymentIntentId } });
  if (!attempt || attempt.status !== "PENDING") return attempt;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", failureReason: reason.slice(0, 500) },
    });
    await releaseOfferHold(attempt.offerId, tx);
    return updated;
  });
}

export async function expireStalePaymentAttempts() {
  const stale = await prisma.paymentAttempt.findMany({
    where: { status: "PENDING", expiresAt: { lte: new Date() } },
    select: { id: true },
    take: 100,
  });
  let expired = 0;
  for (const candidate of stale) {
    const changed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-attempt:${candidate.id}`}))`;
      const attempt = await tx.paymentAttempt.findUnique({ where: { id: candidate.id } });
      if (!attempt || attempt.status !== "PENDING" || attempt.expiresAt > new Date()) return false;
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "EXPIRED", failureReason: "PAYMENT_WINDOW_EXPIRED" } });
      await releaseOfferHold(attempt.offerId, tx);
      return true;
    });
    if (changed) expired += 1;
  }
  return expired;
}

export async function finalizeSuccessfulPayment(params: {
  paymentIntentId: string;
  paymentId?: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}) {
  const result = await prisma.$transaction(async (tx) => {
    const attempt = await tx.paymentAttempt.findUnique({ where: { providerIntentId: params.paymentIntentId } });
    if (!attempt) throw httpError("Payment attempt is not registered", 409, "UNREGISTERED_PAYMENT");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-attempt:${attempt.id}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`service:${attempt.serviceId}`}))`;

    const fresh = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
    if (!fresh) throw httpError("Payment attempt not found", 404);
    const existingBooking = await tx.booking.findUnique({ where: { paymentAttemptId: fresh.id } });
    if (fresh.status === "SUCCEEDED" && existingBooking) return { booking: existingBooking, queue: null, created: false, refundRequired: false };
    if (["REFUND_REQUIRED", "REFUNDED"].includes(fresh.status)) return { booking: null, queue: null, created: false, refundRequired: fresh.status === "REFUND_REQUIRED", attempt: fresh };

    const amount = Number(fresh.amount);
    const metadataValid = params.currency === "PHP" && Math.abs(params.amount - amount) < 0.005 &&
      params.metadata.servicehub_attempt_id === fresh.id && params.metadata.servicehub_seeker_id === fresh.seekerId &&
      params.metadata.servicehub_service_id === fresh.serviceId && (params.metadata.servicehub_offer_id || "") === (fresh.offerId || "") &&
      params.metadata.servicehub_expected_amount === amount.toFixed(2) && params.metadata.servicehub_payment_method === fresh.paymentMethod;
    if (!metadataValid) throw httpError("Captured payment metadata does not match the local attempt", 409, "PAYMENT_MISMATCH");

    if (fresh.expiresAt <= new Date()) {
      await tx.paymentAttempt.update({
        where: { id: fresh.id },
        data: { status: "REFUND_REQUIRED", providerPaymentId: params.paymentId || null, failureReason: "PAYMENT_CONFIRMED_AFTER_ATTEMPT_EXPIRED" },
      });
      await releaseOfferHold(fresh.offerId, tx);
      return { booking: null, queue: null, created: false, refundRequired: true, attempt: { ...fresh, providerPaymentId: params.paymentId } };
    }

    const service = await tx.service.findUnique({
      where: { id: fresh.serviceId },
      select: {
        id: true,
        title: true,
        providerId: true,
        queueLimit: true,
        estimatedDurationMins: true,
        status: true,
        isAvailable: true,
        provider: {
          select: {
            isActive: true,
            moderationStatus: true,
            emailVerified: true,
            verificationStatus: true,
          },
        },
      },
    });
    const ongoingCount = service
      ? await tx.booking.count({ where: { serviceId: fresh.serviceId, status: "ONGOING" } })
      : 0;
    const waitingCount = service
      ? await tx.queue.count({ where: { serviceId: fresh.serviceId, status: "WAITING" } })
      : 0;
    const conflictingBooking = await tx.booking.findFirst({
      where: {
        seekerId: fresh.seekerId,
        serviceId: fresh.serviceId,
        status: { in: ["PENDING_APPROVAL", "ACCEPTED", "WAITING", "ONGOING", "AWAITING_CONFIRMATION", "DISPUTED"] },
      },
      select: { id: true },
    });
    if (
      !service ||
      service.status !== "ACTIVE" ||
      !service.isAvailable ||
        !service.provider.isActive ||
        service.provider.moderationStatus !== "ACTIVE" ||
        !service.provider.emailVerified ||
        service.provider.verificationStatus !== "APPROVED" ||
        ongoingCount + waitingCount >= service.queueLimit ||
      Boolean(conflictingBooking)
    ) {
      await tx.paymentAttempt.update({
        where: { id: fresh.id },
        data: {
          status: "REFUND_REQUIRED",
          providerPaymentId: params.paymentId || null,
          failureReason: conflictingBooking
            ? "ACTIVE_BOOKING_CREATED_BEFORE_PAYMENT_CAPTURE"
            : "SERVICE_OR_QUEUE_UNAVAILABLE_AFTER_CAPTURE",
        },
      });
      await releaseOfferHold(fresh.offerId, tx);
      return { booking: null, queue: null, created: false, refundRequired: true, attempt: { ...fresh, providerPaymentId: params.paymentId } };
    }

    if (fresh.offerId) {
      const offer = await tx.offer.findUnique({ where: { id: fresh.offerId }, include: { request: true } });
      if (!offer || offer.status !== "PENDING_PAYMENT" || offer.request.status !== "PAYMENT_PENDING" || offer.paymentHoldExpiresAt === null) {
        await tx.paymentAttempt.update({ where: { id: fresh.id }, data: { status: "REFUND_REQUIRED", providerPaymentId: params.paymentId || null, failureReason: "OFFER_HOLD_INVALID_AFTER_CAPTURE" } });
        return { booking: null, queue: null, created: false, refundRequired: true, attempt: { ...fresh, providerPaymentId: params.paymentId } };
      }
    }

    const position = ongoingCount + waitingCount + 1;
    const booking = await tx.booking.create({
      data: {
        seekerId: fresh.seekerId,
        providerId: fresh.providerId,
        serviceId: fresh.serviceId,
        offerId: fresh.offerId,
        originType: fresh.offerId ? "OFFER" : "DIRECT_LISTING",
        paymentAttemptId: fresh.id,
        paymentMethod: displayMethod(fresh.paymentMethod),
        agreedAmount: fresh.amount,
        paymentStatus: "PAID_HELD",
        status: "ACCEPTED",
        queuePosition: position,
        started: false,
      },
    });
    const queue = await tx.queue.create({
      data: {
        serviceId: fresh.serviceId,
        seekerId: fresh.seekerId,
        offerId: fresh.offerId,
        paymentId: params.paymentIntentId,
        paymongoPaymentId: params.paymentId || null,
        paymentStatus: "PAID_HELD",
        position,
        status: "WAITING",
        estimatedWait: service.estimatedDurationMins * (position - 1),
        bookingId: booking.id,
      },
    });
    // A successful booking consumes any stale waitlist request for this seeker.
    await tx.queueNotify.deleteMany({
      where: { serviceId: fresh.serviceId, seekerId: fresh.seekerId },
    });
    await recalculateQueueInTransaction(tx, fresh.serviceId);
    await tx.paymentAttempt.update({ where: { id: fresh.id }, data: { status: "SUCCEEDED", providerPaymentId: params.paymentId || null } });

    if (fresh.offerId) {
      const offer = await tx.offer.update({ where: { id: fresh.offerId }, data: { status: "ACCEPTED", paymentHoldExpiresAt: null } });
      await tx.offer.updateMany({ where: { requestId: offer.requestId, id: { not: offer.id }, status: "PENDING" }, data: { status: "REJECTED" } });
      await tx.serviceRequest.update({ where: { id: offer.requestId }, data: { status: "IN_PROGRESS" } });
    }
    return { booking, queue, created: true, refundRequired: false, service };
  });

  if (result.created && result.booking && result.service) {
    await prisma.notification.create({
      data: {
        userId: result.booking.providerId,
        title: "New paid booking",
        body: `Payment was confirmed for "${result.service.title}". The booking is ready in your queue.`,
        link: `/provider/provider-activity?tab=waiting&booking=${result.booking.id}`,
      },
    });
    safeEmit(`service:${result.booking.serviceId}`, "queue_update", { serviceId: result.booking.serviceId });
    safeEmit(`user:${result.booking.providerId}`, "ENGAGEMENT_CHANGED", { bookingId: result.booking.id, type: "queue_created" });
    safeEmit(`user:${result.booking.seekerId}`, "ENGAGEMENT_CHANGED", { bookingId: result.booking.id, type: "queue_created" });
  }
  return result;
}

export async function refundCapturedAttempt(attemptId: string) {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.status === "REFUNDED") return attempt;
  if (attempt.status !== "REFUND_REQUIRED" || !attempt.providerPaymentId) return attempt;

  const refundRecord = await prisma.paymentRefund.upsert({
    where: { paymentAttemptId: attempt.id },
    create: {
      paymentAttemptId: attempt.id,
      paymentId: attempt.providerPaymentId,
      amount: attempt.amount,
      reason: "others",
      requestedById: attempt.seekerId,
      status: "PENDING",
    },
    update: {},
  });
  if (refundRecord.status === "SUCCEEDED") return attempt;

  try {
    const refund = await createRefund({
      paymentId: attempt.providerPaymentId,
      amount: Number(attempt.amount),
      reason: "others",
      idempotencyKey: `servicehub-attempt-refund-${attempt.id}`,
    });
    await prisma.$transaction([
      prisma.paymentRefund.update({ where: { id: refundRecord.id }, data: { paymongoRefundId: refund.id, status: "SUCCEEDED" } }),
      prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "REFUNDED" } }),
    ]);
    return prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
  } catch (error: any) {
    await prisma.paymentRefund.update({ where: { id: refundRecord.id }, data: { status: "FAILED", failureReason: String(error?.code || error?.message || "REFUND_FAILED").slice(0, 500) } });
    throw error;
  }
}
