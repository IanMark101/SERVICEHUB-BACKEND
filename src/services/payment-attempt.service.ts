import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { recordBookingProgress } from "./booking-progress.service";
import { safeEmit } from "../lib/socket";
import {
  attachPaymentMethod,
  createPaymentIntent,
  createPaymentMethod,
  createRefund,
  getPaymentIntent,
} from "./paymongo.service";
import { emitProviderQueueUpdates, lockProviderQueue, recalculateQueueInTransaction } from "./queue.service";
import { lockAccountLifecycle, marketplaceParticipantsEligible } from "./account-lifecycle.service";
import { rejectSiblingOffersAndNotify } from "./offer-selection-notifications.service";
import { calculateDirectListingTerms } from "./bookings/direct-listing-pricing";
import { assertRequestPaymentMethod } from "./request-payment-methods";

const ATTEMPT_TTL_MS = 15 * 60 * 1000;
type OnlineMethod = "gcash";

function httpError(message: string, status: number, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

function displayMethod(method: string) {
  return method === "gcash" ? "GCash" : method;
}

function emitOfferPaymentChange(attempt: { offerId: string | null; seekerId: string; providerId: string }) {
  if (!attempt.offerId) return;
  for (const userId of [attempt.seekerId, attempt.providerId]) {
    safeEmit(`user:${userId}`, 'OFFERS_CHANGED', { offerId: attempt.offerId, type: 'offer_payment_changed' });
  }
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
  serviceId?: string;
  offerId?: string;
  quantity?: number;
  paymentMethod: OnlineMethod;
}) {
  if (!env.PAYMONGO_PUBLIC_KEY || !env.PAYMONGO_SECRET_KEY || !env.PAYMONGO_WEBHOOK_SECRET) {
    throw httpError("Online payment is unavailable until PayMongo Test Mode and its webhook are fully configured", 503, "PAYMENT_NOT_CONFIGURED");
  }
  const expiresAt = new Date(Date.now() + ATTEMPT_TTL_MS);
  const targetOffer = params.offerId
    ? await prisma.offer.findUnique({ where: { id: params.offerId }, select: { requestId: true, providerId: true, serviceId: true } })
    : null;
  if (params.offerId && !targetOffer) throw httpError("Offer not found", 404);
  if (!params.offerId && !params.serviceId) throw httpError("Choose a service or offer", 400);
  const initialService = !params.offerId && params.serviceId
    ? await prisma.service.findUnique({ where: { id: params.serviceId }, select: { providerId: true } }) : null;
  if (!targetOffer && !initialService) throw httpError("Service not found", 404);
  const providerId = targetOffer?.providerId ?? initialService!.providerId;
  const serviceId = targetOffer ? targetOffer.serviceId : params.serviceId!;
  const quantity = params.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 40 || (targetOffer && quantity !== 1)) {
    throw httpError("Choose a valid number of hours or days", 400);
  }

  const prepared = await prisma.$transaction(async (tx) => {
    if (targetOffer) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${targetOffer.requestId}`}))`;
    }
    await lockAccountLifecycle(tx, params.seekerId, providerId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${params.seekerId}:${params.offerId || serviceId}`}))`;

    const stale = await tx.paymentAttempt.findMany({
      where: {
        seekerId: params.seekerId,
        serviceId: serviceId || null,
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
        serviceId: serviceId || null,
        offerId: params.offerId || null,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
    });
    if (existing) {
      if (existing.quantity !== quantity) throw httpError("A payment is already pending for a different quantity", 409);
      return { attempt: existing, reused: true };
    }

    const service = !params.offerId && serviceId ? await tx.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        title: true,
        providerId: true,
        categoryId: true,
        price: true,
        priceType: true,
        serviceType: true,
        estimatedDurationMins: true,
        paymentMethods: true,
        status: true,
        isAvailable: true,
        queueLimit: true,
        provider: {
          select: { isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true },
        },
      },
    }) : null;
    if (!params.offerId && !service) throw httpError("Service not found", 404);
    if (service && service.providerId !== providerId) throw httpError("Service provider changed during payment preparation", 409);
    if (!(await marketplaceParticipantsEligible(tx, params.seekerId, providerId))) {
      throw httpError("Both participants must be eligible for a new payment", 409, "PARTICIPANT_INELIGIBLE");
    }
    if (providerId === params.seekerId) throw httpError("You cannot book your own offer or service", 403, "SELF_TRANSACTION_NOT_ALLOWED");
    const directTerms = service ? calculateDirectListingTerms(service.priceType, service.price, quantity, service.estimatedDurationMins) : null;
    if (service && (service.status !== "ACTIVE" || !service.isAvailable)) throw httpError("This service is not available", 409);
    const provider = await tx.user.findUnique({ where: { id: providerId }, select: { isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true, onlineQueueLimit: true } });
    if (!provider?.isActive || provider.moderationStatus !== "ACTIVE" || !provider.emailVerified || provider.verificationStatus !== "APPROVED") {
      throw httpError("The provider is not currently eligible to accept a new booking", 409, "PROVIDER_UNAVAILABLE");
    }

    const existingBooking = await tx.booking.findFirst({
      where: {
        seekerId: params.seekerId,
        ...(params.offerId ? { offerId: params.offerId } : { serviceId: service!.id }),
        status: { in: ["PENDING_APPROVAL", "ACCEPTED", "WAITING", "ONGOING", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"] },
      },
      select: { id: true },
    });
    if (existingBooking) throw httpError("You already have an active booking for this service", 409, "ACTIVE_BOOKING_EXISTS");

    if (service && !(service.paymentMethods as { gcash?: boolean })?.gcash) throw httpError("This payment method is not accepted for the service", 400);

    // Prisma's PostgreSQL adapter uses one connection for this transaction;
    // execute transaction-client queries serially instead of overlapping them.
    const waitingCount = await tx.queue.count({ where: { providerId, status: "WAITING" } });
    if (waitingCount >= provider.onlineQueueLimit) throw httpError("The provider's paid work queue is full", 409, "QUEUE_FULL");

    let amount = directTerms ? Number(directTerms.amount) : Number.NaN;
    let offerRequestId: string | undefined;
    if (params.offerId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offer-selection:${params.offerId}`}))`;
      const offer = await tx.offer.findUnique({
        where: { id: params.offerId },
        include: { request: { select: {
          id: true, seekerId: true, categoryId: true, status: true, targetServiceId: true, preferredPaymentMethod: true, paymentMethods: true,
        } } },
      });
      if (!offer || offer.status !== "PENDING" || offer.request.status !== "OPEN" || offer.request.seekerId !== params.seekerId || offer.providerId !== providerId || offer.serviceId !== (serviceId || null)) {
        throw httpError("The offer is no longer payable", 409, "OFFER_NOT_PAYABLE");
      }
      assertRequestPaymentMethod(offer.request, "gcash");
      if (offer.request.targetServiceId) {
        if (offer.request.preferredPaymentMethod !== "GCash" || offer.serviceId !== offer.request.targetServiceId) {
          throw httpError("This inquiry was requested with a different payment method or listing", 409);
        }
        const listedService = await tx.service.findUnique({ where: { id: offer.serviceId! }, select: { paymentMethods: true } });
        if (!(listedService?.paymentMethods as { gcash?: boolean } | null)?.gcash) {
          throw httpError("This listing no longer accepts GCash", 409);
        }
      }
      amount = Number(offer.offeredPrice);
      offerRequestId = offer.requestId;
      await tx.offer.update({
        where: { id: offer.id },
        data: { status: "PENDING_PAYMENT", paymentHoldExpiresAt: expiresAt },
      });
      await tx.serviceRequest.update({ where: { id: offer.requestId }, data: { status: "PAYMENT_PENDING" } });
    }

    if (!Number.isFinite(amount) || amount < 50 || amount > 50_000) throw httpError("The booking amount is invalid", 400);
    const idempotencyKey = `servicehub-attempt-${crypto.randomUUID()}`;
    const attempt = await tx.paymentAttempt.create({
      data: {
        idempotencyKey,
        seekerId: params.seekerId,
        providerId,
        serviceId: serviceId || null,
        quantity,
        offerId: params.offerId || null,
        amount,
        paymentMethod: params.paymentMethod,
        expiresAt,
      },
    });
    return { attempt, reused: false, serviceTitle: service?.title, offerRequestId };
  });

  // The hold is already committed. Both workspaces must see that this offer
  // cannot be declined or withdrawn while payment is in progress.
  emitOfferPaymentChange(prepared.attempt);
  if (prepared.reused && prepared.attempt.providerIntentId) {
    // A locally pending attempt can already have a failed/expired GCash source.
    // Never hand its old redirect URL back without checking PayMongo first.
    const current = await reconcileOnlinePaymentReturn(params.seekerId, prepared.attempt.providerIntentId);
    if (current.status === "PENDING") return prepared.attempt;
    if (current.status === "SUCCEEDED") throw httpError("This payment already created a booking", 409, "ACTIVE_BOOKING_EXISTS");
    if (["FAILED", "EXPIRED"].includes(current.status)) return initiateOnlinePayment(params);
    throw httpError("This payment needs review before another attempt", 409, "PAYMENT_REVIEW_REQUIRED");
  }
  if (prepared.reused && prepared.attempt.redirectUrl) return prepared.attempt;

  try {
    const attempt = prepared.attempt;
    const intent = await createPaymentIntent({
      amount: Number(attempt.amount),
      description: `ServiceHub Cordova ${attempt.offerId ? "offer" : "service"} booking`,
      paymentMethod: attempt.paymentMethod as OnlineMethod,
      idempotencyKey: attempt.idempotencyKey,
      metadata: {
        servicehub_attempt_id: attempt.id,
        servicehub_seeker_id: attempt.seekerId,
        servicehub_service_id: attempt.serviceId || "",
        servicehub_offer_id: attempt.offerId || "",
        servicehub_expected_amount: Number(attempt.amount).toFixed(2),
        servicehub_payment_method: attempt.paymentMethod,
      },
    });
    const methodId = await createPaymentMethod(attempt.paymentMethod);
    const returnUrl = new URL("/seeker/payment-return", env.FRONTEND_URL);
    returnUrl.searchParams.set("payment_intent_id", intent.id);
    const attached = await attachPaymentMethod({
      paymentIntentId: intent.id,
      paymentMethodId: methodId,
      clientKey: intent.clientKey,
      returnUrl: returnUrl.toString(),
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
      if (targetOffer) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${targetOffer.requestId}`}))`;
      }
      await tx.paymentAttempt.update({
        where: { id: prepared.attempt.id },
        data: { status: "FAILED", failureReason: error?.code || "PAYMENT_PROVIDER_ERROR" },
      });
      await releaseOfferHold(prepared.attempt.offerId, tx);
    });
    emitOfferPaymentChange(prepared.attempt);
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

/**
 * A checkout return is not evidence of payment. Re-read the intent from
 * PayMongo with the server secret, then use the same locked, idempotent
 * finalizer as the signed webhook. This also recovers local checkouts whose
 * webhook cannot reach a localhost backend.
 */
export async function reconcileOnlinePaymentReturn(seekerId: string, paymentIntentId: string) {
  const attempt = await getPaymentAttemptStatus(seekerId, paymentIntentId);
  if (["PENDING", "EXPIRED", "FAILED"].includes(attempt.status)) {
    const intent = await getPaymentIntent(paymentIntentId);
    if (intent.id !== paymentIntentId) throw httpError("Payment provider returned a different intent", 409, "PAYMENT_MISMATCH");
    if (intent.status === "succeeded") {
      const finalized = await finalizeSuccessfulPayment({
        paymentIntentId: intent.id,
        paymentId: intent.paymentId,
        amount: intent.amount,
        currency: intent.currency,
        metadata: intent.metadata,
      });
      if (finalized.refundRequired && finalized.attempt?.id) {
        await refundCapturedAttempt(finalized.attempt.id);
      }
    } else if (["awaiting_payment_method", "failed", "canceled", "cancelled", "expired"].includes(intent.status)) {
      await markPaymentAttemptFailed(paymentIntentId, "PAYMENT_METHOD_FAILED_OR_EXPIRED");
    }
  }
  return getPaymentAttemptStatus(seekerId, paymentIntentId);
}

export async function markPaymentAttemptFailed(paymentIntentId: string, reason: string) {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { providerIntentId: paymentIntentId } });
  if (!attempt || attempt.status !== "PENDING") return attempt;
  const offer = attempt.offerId ? await prisma.offer.findUnique({ where: { id: attempt.offerId }, select: { requestId: true } }) : null;
  const result = await prisma.$transaction(async (tx) => {
    if (offer) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${offer.requestId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-attempt:${attempt.id}`}))`;
    const updated = await tx.paymentAttempt.updateMany({
      where: { id: attempt.id, status: "PENDING" },
      data: { status: "FAILED", failureReason: reason.slice(0, 500) },
    });
    if (updated.count !== 1) return tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
    await releaseOfferHold(attempt.offerId, tx);
    return tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
  });
  emitOfferPaymentChange(attempt);
  return result;
}

export async function expireStalePaymentAttempts() {
  const stale = await prisma.paymentAttempt.findMany({
    where: { status: "PENDING", expiresAt: { lte: new Date() } },
    select: { id: true },
    take: 100,
  });
  let expired = 0;
  for (const candidate of stale) {
    const candidateAttempt = await prisma.paymentAttempt.findUnique({ where: { id: candidate.id }, select: { offerId: true, seekerId: true, providerId: true } });
    const candidateOffer = candidateAttempt?.offerId ? await prisma.offer.findUnique({ where: { id: candidateAttempt.offerId }, select: { requestId: true } }) : null;
    const changed = await prisma.$transaction(async (tx) => {
      if (candidateOffer) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${candidateOffer.requestId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-attempt:${candidate.id}`}))`;
      const attempt = await tx.paymentAttempt.findUnique({ where: { id: candidate.id } });
      if (!attempt || attempt.status !== "PENDING" || attempt.expiresAt > new Date()) return false;
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "EXPIRED", failureReason: "PAYMENT_WINDOW_EXPIRED" } });
      await releaseOfferHold(attempt.offerId, tx);
      return true;
    });
    if (changed) {
      expired += 1;
      if (candidateAttempt) emitOfferPaymentChange(candidateAttempt);
    }
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
  const initialAttempt = await prisma.paymentAttempt.findUnique({
    where: { providerIntentId: params.paymentIntentId },
    select: { id: true, seekerId: true, serviceId: true, offerId: true },
  });
  if (!initialAttempt) throw httpError("Payment attempt is not registered", 409, "UNREGISTERED_PAYMENT");
  const initialOffer = initialAttempt.offerId
    ? await prisma.offer.findUnique({ where: { id: initialAttempt.offerId }, select: { requestId: true } })
    : null;
  const result = await prisma.$transaction(async (tx) => {
    if (initialOffer) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${initialOffer.requestId}`}))`;
    }
    const initialProvider = await tx.paymentAttempt.findUnique({ where: { id: initialAttempt.id }, select: { providerId: true } });
    if (!initialProvider) throw httpError("Payment attempt not found", 404);
    await lockAccountLifecycle(tx, initialAttempt.seekerId, initialProvider.providerId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment-attempt:${initialAttempt.id}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payment:${initialAttempt.seekerId}:${initialAttempt.offerId || initialAttempt.serviceId}`}))`;
    await lockProviderQueue(tx, initialProvider.providerId);

    const fresh = await tx.paymentAttempt.findUnique({ where: { id: initialAttempt.id } });
    if (!fresh) throw httpError("Payment attempt not found", 404);
    const existingBooking = await tx.booking.findUnique({ where: { paymentAttemptId: fresh.id } });
    if (fresh.status === "SUCCEEDED" && existingBooking) return { booking: existingBooking, queue: null, created: false, refundRequired: false };
    if (["REFUND_REQUIRED", "REFUNDED"].includes(fresh.status)) return { booking: null, queue: null, created: false, refundRequired: fresh.status === "REFUND_REQUIRED", attempt: fresh };

    const amount = Number(fresh.amount);
    const metadataValid = params.currency === "PHP" && Math.abs(params.amount - amount) < 0.005 &&
      params.metadata.servicehub_attempt_id === fresh.id && params.metadata.servicehub_seeker_id === fresh.seekerId &&
      (params.metadata.servicehub_service_id || "") === (fresh.serviceId || "") && (params.metadata.servicehub_offer_id || "") === (fresh.offerId || "") &&
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

    const service = !fresh.offerId && fresh.serviceId ? await tx.service.findUnique({
      where: { id: fresh.serviceId },
      select: {
        id: true,
        title: true,
        providerId: true,
        queueLimit: true,
        estimatedDurationMins: true,
        priceType: true,
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
    }) : null;
    const provider = await tx.user.findUnique({ where: { id: fresh.providerId }, select: {
      isActive: true, moderationStatus: true, emailVerified: true, verificationStatus: true, onlineQueueLimit: true,
    } });
    const participantsEligible = await marketplaceParticipantsEligible(tx, fresh.seekerId, fresh.providerId);
    const servingCount = await tx.queue.count({ where: { providerId: fresh.providerId, status: "SERVING" } });
    const waitingCount = await tx.queue.count({ where: { providerId: fresh.providerId, status: "WAITING" } });
    const conflictingBooking = await tx.booking.findFirst({
      where: {
        seekerId: fresh.seekerId,
        ...(fresh.offerId ? { offerId: fresh.offerId } : { serviceId: fresh.serviceId }),
        status: { in: ["PENDING_APPROVAL", "ACCEPTED", "WAITING", "ONGOING", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"] },
      },
      select: { id: true },
    });
    if (
      (!fresh.offerId && !service) ||
      !participantsEligible ||
      (service && (service.providerId !== fresh.providerId || service.status !== "ACTIVE" || !service.isAvailable)) ||
      !provider?.isActive || provider.moderationStatus !== "ACTIVE" || !provider.emailVerified || provider.verificationStatus !== "APPROVED" ||
      waitingCount >= provider.onlineQueueLimit ||
      Boolean(conflictingBooking)
    ) {
      await tx.paymentAttempt.update({
        where: { id: fresh.id },
        data: {
          status: "REFUND_REQUIRED",
          providerPaymentId: params.paymentId || null,
          failureReason: conflictingBooking
            ? "ACTIVE_BOOKING_CREATED_BEFORE_PAYMENT_CAPTURE"
            : !participantsEligible ? "PARTICIPANT_INELIGIBLE_AFTER_CAPTURE" : "PROVIDER_OR_QUEUE_UNAVAILABLE_AFTER_CAPTURE",
        },
      });
      await releaseOfferHold(fresh.offerId, tx);
      return { booking: null, queue: null, created: false, refundRequired: true, attempt: { ...fresh, providerPaymentId: params.paymentId } };
    }

    if (fresh.offerId) {
      const offer = await tx.offer.findUnique({ where: { id: fresh.offerId }, include: { request: true } });
      if (!offer || offer.providerId !== fresh.providerId || offer.serviceId !== fresh.serviceId || offer.request.seekerId !== fresh.seekerId || offer.status !== "PENDING_PAYMENT" || offer.request.status !== "PAYMENT_PENDING" || offer.paymentHoldExpiresAt === null) {
        await tx.paymentAttempt.update({ where: { id: fresh.id }, data: { status: "REFUND_REQUIRED", providerPaymentId: params.paymentId || null, failureReason: "OFFER_HOLD_INVALID_AFTER_CAPTURE" } });
        return { booking: null, queue: null, created: false, refundRequired: true, attempt: { ...fresh, providerPaymentId: params.paymentId } };
      }
      const competingSelection = await tx.offer.findFirst({
        where: {
          requestId: offer.requestId,
          id: { not: offer.id },
          status: { in: ["PENDING_PAYMENT", "ACCEPTED"] },
        },
        select: { id: true },
      });
      if (competingSelection) {
        await tx.paymentAttempt.update({ where: { id: fresh.id }, data: { status: "REFUND_REQUIRED", providerPaymentId: params.paymentId || null, failureReason: "SIBLING_OFFER_ALREADY_SELECTED" } });
        await tx.offer.updateMany({ where: { id: fresh.offerId, status: "PENDING_PAYMENT" }, data: { status: "REJECTED", paymentHoldExpiresAt: null } });
        return { booking: null, queue: null, created: false, refundRequired: true, attempt: { ...fresh, providerPaymentId: params.paymentId } };
      }
    }

    const position = servingCount + waitingCount + 1;
    const offerTerms = fresh.offerId ? await tx.offer.findUnique({ where: { id: fresh.offerId }, select: { estimatedDuration: true, request: { select: { title: true } } } }) : null;
    const estimatedDurationMins = offerTerms?.estimatedDuration ?? (service?.priceType === "PER_HOUR" ? 60 * fresh.quantity : service?.priceType === "PER_DAY" ? 480 * fresh.quantity : service?.estimatedDurationMins ?? 60);
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
        estimatedDurationMins,
        paymentStatus: "PAID_HELD",
        status: "ACCEPTED",
        queuePosition: position,
        started: false,
      },
    });
    // Paid bookings become accepted automatically after payment confirmation.
    await recordBookingProgress(tx, booking.id, "ACCEPTED", "SYSTEM");
    const queue = await tx.queue.create({
      data: {
        providerId: fresh.providerId,
        serviceId: fresh.serviceId,
        seekerId: fresh.seekerId,
        offerId: fresh.offerId,
        paymentId: params.paymentIntentId,
        paymongoPaymentId: params.paymentId || null,
        paymentStatus: "PAID_HELD",
        position,
        status: "WAITING",
        estimatedWait: 0,
        bookingId: booking.id,
      },
    });
    // A successful booking consumes any stale waitlist request for this seeker.
    await tx.queueNotify.deleteMany({
      where: { service: { providerId: fresh.providerId }, seekerId: fresh.seekerId },
    });
    await recalculateQueueInTransaction(tx, fresh.providerId);
    await tx.paymentAttempt.update({ where: { id: fresh.id }, data: { status: "SUCCEEDED", providerPaymentId: params.paymentId || null } });

    let losingProviderIds: string[] = [];
    if (fresh.offerId) {
      const offer = await tx.offer.update({ where: { id: fresh.offerId }, data: { status: "ACCEPTED", paymentHoldExpiresAt: null } });
      losingProviderIds = await rejectSiblingOffersAndNotify(tx, offer.requestId, offer.id, offerTerms?.request.title ?? 'service request');
      await tx.serviceRequest.update({ where: { id: offer.requestId }, data: { status: "IN_PROGRESS" } });
    }
    return { booking, queue, created: true, refundRequired: false, title: offerTerms?.request.title ?? service?.title ?? "your service", losingProviderIds };
  });

  if (result.created && result.booking && result.queue) {
    if ('losingProviderIds' in result) {
      for (const providerId of result.losingProviderIds) {
        safeEmit(`user:${providerId}`, 'notification', { title: 'Another offer was selected' });
        safeEmit(`user:${providerId}`, 'ENGAGEMENT_CHANGED', { type: 'offer_not_selected' });
      }
    }
    await emitProviderQueueUpdates(result.booking.providerId).catch((error) => console.error("Queue refresh event failed", error));
    await prisma.notification.create({
      data: {
        userId: result.booking.providerId,
        title: "Paid booking ready to start",
        body: result.queue.position === 1
          ? `Payment was confirmed for "${result.title}". This customer is first in your paid work queue and ready for you to start.`
          : `Payment was confirmed for "${result.title}". This customer is now in your paid work queue at position ${result.queue.position}.`,
        link: `/provider/provider-activity?tab=waiting&booking=${result.booking.id}`,
      },
    });
    safeEmit(`user:${result.booking.providerId}`, "notification", { title: "Paid booking ready to start" });
    safeEmit(`user:${result.booking.providerId}`, "queue_update", { providerId: result.booking.providerId });
    if (result.booking.serviceId) safeEmit(`service:${result.booking.serviceId}`, "queue_update", { serviceId: result.booking.serviceId });
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
  if (["SUCCEEDED", "SIMULATED_TEST_MODE"].includes(refundRecord.status)) return attempt;

  try {
    const refund = await createRefund({
      paymentId: attempt.providerPaymentId,
      amount: Number(attempt.amount),
      reason: "others",
      idempotencyKey: `servicehub-attempt-refund-${attempt.id}`,
    });
    await prisma.$transaction(async (tx) => {
      await tx.paymentRefund.update({
        where: { id: refundRecord.id },
        data: { paymongoRefundId: refund.id, status: refund.status.toUpperCase() },
      });
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "REFUNDED" } });
    });
    return prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
  } catch (error: any) {
    await prisma.paymentRefund.update({ where: { id: refundRecord.id }, data: { status: "FAILED", failureReason: String(error?.code || error?.message || "REFUND_FAILED").slice(0, 500) } });
    throw error;
  }
}
