import { assertNewProviderBusiness } from './provider-membership.service';
import { resolveOfferArrangement, publicOffer } from '../lib/service-arrangement';
import type { BookingLocationMode, JobLocation } from '../schema/location.schema';
import { prisma } from "../lib/prisma";
import { assertDistinctAccounts } from "../utils/security";
import { safeEmit } from "../lib/socket";
import { lockAccountLifecycle } from "./account-lifecycle.service";
import { assertOfferParticipant, assertOfferTarget } from './offer-eligibility';

export async function submitOffer(providerId: string, params: {
  requestId: string;
  serviceId?: string;
  offeredPrice: number;
  estimatedDuration: number;
  availability?: string;
  message?: string;
  serviceLocationMode?: BookingLocationMode;
  providerVenue?: JobLocation;
}) {
  const { requestId, serviceId, offeredPrice, estimatedDuration, availability, message } = params;
  return prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${requestId}`}))`;
  // Check request is open and accepting offers
  const request = await tx.serviceRequest.findUnique({
    where: { id: requestId },
    select: { status: true, seekerId: true, categoryId: true, targetProviderId: true, targetServiceId: true, preferredPaymentMethod: true, latitude: true, longitude: true, locationLabel: true, privateAddress: true, serviceLocationMode: true },
  });

  if (!request) {
    const err = new Error("This service request is no longer available.") as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
  assertDistinctAccounts(providerId, request.seekerId, "submit offer");
  await lockAccountLifecycle(tx, providerId, request.seekerId);
  await assertOfferParticipant(tx, providerId, 'provider');
  await assertNewProviderBusiness(tx, providerId);
  await assertOfferParticipant(tx, request.seekerId, 'seeker');
  assertOfferTarget(request, providerId, serviceId);
  if (request.targetServiceId && !request.preferredPaymentMethod && (message?.trim().length ?? 0) < 10) {
    throw Object.assign(new Error('Explain what is included in your price using at least 10 characters.'), { status: 400 });
  }
  // An old request may incorrectly remain OPEN after a booking was completed.
  // The booking, not that stale request flag, is authoritative for fulfillment.
  const existingBooking = await tx.booking.findFirst({
    where: { offer: { requestId }, status: { notIn: ["DECLINED", "CANCELED", "REMOVED"] } },
    select: { id: true },
  });
  if (existingBooking) {
    const err = new Error("This request already led to a booking. Ask the seeker to post a new request for more work.") as Error & { status?: number; code?: string };
    err.status = 409;
    err.code = "REQUEST_ALREADY_MATCHED";
    throw err;
  }

  if (request.status !== "OPEN") {
    const err = new Error("This service request is currently paused or closed by the seeker and is no longer accepting new offers.") as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const service = serviceId ? await tx.service.findUnique({
      where: { id: serviceId },
      select: { providerId: true, categoryId: true, priceType: true, status: true, isAvailable: true, latitude: true, longitude: true, coverageRadiusKm: true, locationLabel: true, serviceLocationMode: true, venueAddress: true },
    }) : null;
  if (serviceId) {
    if (!service || service.providerId !== providerId || service.categoryId !== request.categoryId || service.status !== "ACTIVE" || !service.isAvailable) {
      throw Object.assign(new Error(request.targetServiceId
        ? 'The requested listing is no longer available. Ask the seeker to choose an available listing or post a new request.'
        : 'That listing is unavailable or does not match this request. Choose an active listing in this category, or select “No listing” to send a custom offer.'), { status: 400, code: 'OFFER_LISTING_UNAVAILABLE' });
    }
  }
  if (request.targetServiceId && !request.preferredPaymentMethod && service?.priceType !== 'BY_AGREEMENT') {
    throw Object.assign(new Error('This service has a set price. Close the old inquiry and ask the seeker to book at the listed price.'), { status: 409, code: 'FIXED_PRICE_BOOKING_REQUIRED' });
  }
  const arrangement = resolveOfferArrangement(request, service, params.serviceLocationMode, params.providerVenue);

  // Prevent duplicate offer from same provider
  const existing = await tx.offer.findFirst({
    where: { requestId, providerId, status: { in: ["PENDING", "PENDING_PAYMENT", "ACCEPTED"] } },
  });

  if (existing) {
    const err = new Error("You have already submitted an offer for this request") as any;
    err.status = 409;
    err.code = 'DUPLICATE_OFFER';
    throw err;
  }

  const offer = await tx.offer.create({
    data: {
      requestId,
      providerId,
      serviceId: serviceId || null,
      offeredPrice,
      estimatedDuration,
      availability,
      message,
      serviceLocationMode: arrangement.serviceLocationMode,
      providerVenue: arrangement.providerVenue,
      status: "PENDING",
    },
    include: {
      provider: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          trustScore: true,
          verificationStatus: true,
        },
      },
    },
  });

  // Notify seeker
  await tx.notification.create({
    data: {
      userId: request.seekerId,
      title: request.targetServiceId ? 'Service price proposed' : "New Offer Received",
      body: request.targetServiceId ? `The provider accepted your service request and proposed ₱${offeredPrice}. Review the included work and confirm the price in Offers Received.` : `A provider submitted an offer of ₱${offeredPrice} on your request. Review it in Offers Received.`,
      link: `/seeker/incoming-offers?offer=${offer.id}`,
    },
  });
  return { offer, seekerId: request.seekerId };
  }).then(({ offer, seekerId }) => {
    safeEmit(`user:${seekerId}`, "notification", { title: "New Offer Received" });
    safeEmit(`user:${seekerId}`, "OFFERS_CHANGED", { offerId: offer.id });
    safeEmit(`user:${providerId}`, "OFFERS_CHANGED", { offerId: offer.id, status: offer.status });
    return publicOffer(offer);
  });
}

export async function listReceivedOffers(seekerId: string) {
  const myRequests = await prisma.serviceRequest.findMany({
    where: { seekerId },
    select: { id: true },
  });
  const requestIds = myRequests.map((r) => r.id);

  const offers = await prisma.offer.findMany({
    where: { requestId: { in: requestIds } },
    include: {
      provider: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          trustScore: true,
          verificationStatus: true,
        },
      },
      request: {
        select: {
          id: true,
          seekerId: true,
          title: true,
          status: true,
          paymentMethods: true,
          preferredPaymentMethod: true,
          targetServiceId: true,
        },
      },
    },
    orderBy: [{ provider: { trustScore: "desc" } }, { createdAt: "asc" }],
  });
  return offers.map(publicOffer);
}

export async function acceptOffer(offerId: string, seekerId: string) {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    include: {
      request: {
        select: {
          seekerId: true,
          status: true,
          id: true,
        },
      },
    },
  });

  if (!offer) {
    const err = new Error("Offer not found") as any;
    err.status = 404;
    throw err;
  }

  if (offer.request.seekerId !== seekerId) {
    const err = new Error("Not authorized") as any;
    err.status = 403;
    throw err;
  }

  if (offer.request.status !== "OPEN") {
    const err = new Error("Request is no longer open") as any;
    err.status = 400;
    throw err;
  }

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) — second-layer check ─
  if (seekerId === offer.providerId) {
    const err = new Error("You cannot book or send an offer on your own service listing or request.") as any;
    err.status = 403;
    err.code = "SELF_TRANSACTION_NOT_ALLOWED";
    throw err;
  }

  // Selection alone must not reject sibling offers or move the request to
  // IN_PROGRESS. The chosen cash/online booking path performs that transition
  // atomically with booking creation or verified payment confirmation.
  const paymentRequired = new Error("Choose On-site Cash or GCash to accept this offer") as any;
  paymentRequired.status = 409;
  paymentRequired.code = "PAYMENT_METHOD_REQUIRED";
  throw paymentRequired;
}

export async function rejectOffer(offerId: string, userId: string) {
  const offer = await prisma.offer.findUnique({
    where: { id: offerId },
    include: {
      request: {
        select: {
          seekerId: true,
        },
      },
    },
  });

  if (!offer) {
    const err = new Error("Offer not found") as any;
    err.status = 404;
    throw err;
  }

  const isSeeker = offer.request.seekerId === userId;
  const isProvider = offer.providerId === userId;

  if (!isSeeker && !isProvider) {
    const err = new Error("Not authorized") as any;
    err.status = 403;
    throw err;
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${offer.requestId}`}))`;
    const current = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, include: { request: { select: { title: true, status: true, targetServiceId: true, preferredPaymentMethod: true } } } });
    const nextStatus = isProvider ? 'WITHDRAWN' : 'REJECTED';
    // Only repeat this actor's established decision. A sibling rejection must
    // never be reinterpreted as an explicit decline or produce its notification.
    if (current.status === nextStatus && (isProvider || await tx.notification.findUnique({ where: { id: `offer-declined:${offerId}` } }))) {
      return { updatedOffer: current, changed: false };
    }
    const changed = await tx.offer.updateMany({
      where: { id: offerId, status: "PENDING", request: { status: "OPEN" } },
      data: { status: nextStatus },
    });
    if (changed.count !== 1) {
      const err = new Error("Only an open, pending unpaid offer can be withdrawn or rejected") as Error & { status?: number };
      err.status = 409;
      throw err;
    }
    const closesInquiry = Boolean(current.request.targetServiceId && current.request.preferredPaymentMethod === null);
    if (closesInquiry) await tx.serviceRequest.update({ where: { id: offer.requestId }, data: { status: 'CANCELED' } });
    if (isProvider) await tx.notification.create({ data: {
      id: `${closesInquiry ? 'price-withdrawn' : 'offer-withdrawn'}:${offerId}`, userId: offer.request.seekerId,
      title: closesInquiry ? 'Proposed price withdrawn' : 'Offer withdrawn', body: closesInquiry ? `The provider withdrew the price for "${current.request.title}". This request is closed. You can send a new request; no booking or payment was created.` : `The provider withdrew their offer for "${current.request.title}". Your request remains open to other offers.`,
      link: `/seeker/request-manager?requestId=${encodeURIComponent(offer.requestId)}`,
    } });
    if (!isProvider) await tx.notification.create({ data: {
      id: `offer-declined:${offerId}`,
      userId: offer.providerId,
      title: 'Offer declined',
      body: `The seeker declined your offer for "${current.request.title}".`,
      link: `/provider/provider-activity?tab=all&offer=${encodeURIComponent(offerId)}`,
    } });
    return { updatedOffer: await tx.offer.findUniqueOrThrow({ where: { id: offerId } }), changed: true, closesInquiry };
  });

  if (result.changed) {
    const event = { type: isProvider ? 'offer_withdrawn' : 'offer_declined', offerId, status: result.updatedOffer.status };
    safeEmit(`user:${offer.request.seekerId}`, 'OFFERS_CHANGED', event);
    safeEmit(`user:${offer.providerId}`, 'OFFERS_CHANGED', event);
    if (result.closesInquiry) for (const participant of [offer.request.seekerId, offer.providerId]) safeEmit(`user:${participant}`, 'SERVICE_REQUESTS_CHANGED', { id: offer.requestId, status: 'CANCELED' });
    if (isProvider) safeEmit(`user:${offer.request.seekerId}`, 'notification', { id: `${result.closesInquiry ? 'price-withdrawn' : 'offer-withdrawn'}:${offerId}`, title: result.closesInquiry ? 'Proposed price withdrawn' : 'Offer withdrawn' });
    if (!isProvider) safeEmit(`user:${offer.providerId}`, 'notification', { id: `offer-declined:${offerId}`, title: 'Offer declined', offerId });
  }
  return publicOffer(result.updatedOffer);
}
