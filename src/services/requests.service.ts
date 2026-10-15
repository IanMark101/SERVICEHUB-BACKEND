import { locationData, locationBounds } from '../lib/proximity';
import { listingPhotosInclude, withListingPhotos } from '../lib/listing-photos';
import { setListingPhotos } from './listing-photos.service';
import { marketplaceSearchConditions } from '../lib/marketplace-search';
import { canonicalCategoryName } from '../lib/category-catalog';
import type { JobLocation, NearbyQuery, ServiceLocationMode } from '../schema/location.schema';
import { publicOffer, assertLocationForArrangementChange } from '../lib/service-arrangement';
import { prisma } from "../lib/prisma";
import { publishNotifications } from './notifications.service';
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from "./account-lifecycle.service";
import { assertListingGCashNumber } from './gcash-listing-policy';
import { assessMarketplaceContent, type ContentDecision } from "./content-moderation.service";
import { RequestPaymentMethodsSchema, RequestUrgencySchema } from "../schema/marketplace.schema";
import { getSeekerReviewStats } from "../lib/seeker-review-stats";
import { Prisma } from '@prisma/client';
import { reviewEligibilitySql } from '../lib/review-eligibility';
import { protectedRequestPaymentStatuses, requestDeletionEligibility } from "../lib/request-deletion";
import { canArchiveCompletedRequest } from '../lib/request-archive';

export async function createRequest(seekerId: string, params: {
  photoIds?: string[];
  categoryId: string;
  title: string;
  description: string;
  budgetMin: number;
  budgetMax: number;
  urgency: string;
  paymentMethods?: { cash: boolean; gcash: boolean };
  jobLocation?: JobLocation;
  serviceLocationMode?: ServiceLocationMode;
  transportationFee?: number | null;
}) {
  const { categoryId, title, description, budgetMin, budgetMax, urgency } = params;
  RequestUrgencySchema.parse(urgency);
  const paymentMethods = params.paymentMethods === undefined ? undefined : RequestPaymentMethodsSchema.parse(params.paymentMethods);

  // Validate category exists and is active
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
  });

  if (!category || !category.isActive) {
    const err = new Error("Invalid or inactive category") as any;
    err.status = 400;
    throw err;
  }

  const assessment = assessMarketplaceContent({
    kind: "SERVICE_REQUEST", categoryName: category.name, title, description,
  });
  if (assessment.outcome !== "PASS") {
    await prisma.contentModerationEvent.create({ data: {
      actorId: seekerId, contentType: "SERVICE_REQUEST", outcome: assessment.outcome,
      reasonCode: assessment.reasonCode, policyVersion: assessment.policyVersion,
    } });
    throw Object.assign(new Error(assessment.message), { status: 422, code: "CONTENT_REVISION_REQUIRED", field: assessment.field });
  }

  return prisma.$transaction(async (tx) => {
    await lockAccountLifecycle(tx, seekerId);
    await assertActiveMarketplaceAccount(tx, seekerId);
    await assertListingGCashNumber(tx, seekerId, paymentMethods);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seeker-requests:${seekerId}`}))`;
    const activeRequests = await tx.serviceRequest.findMany({
      where: { seekerId, categoryId, archivedAt: null, status: { in: ["OPEN", "PAYMENT_PENDING", "IN_PROGRESS"] } },
      select: { title: true, offers: { select: { status: true, booking: { select: { status: true } } } } },
    });
    const normalizedTitle = title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (activeRequests.some((item) => !canArchiveCompletedRequest(item.offers) && item.title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase() === normalizedTitle)) {
      throw Object.assign(new Error("You already have an active request with this title and category."), { status: 409, code: "DUPLICATE_REQUEST" });
    }

    const request = await tx.serviceRequest.create({
      data: {
        seekerId, categoryId, title, description, budgetMin, budgetMax, urgency,
        ...(params.jobLocation && { ...locationData(params.jobLocation), privateAddress: ['SEEKER_VISITS', 'REMOTE'].includes(params.serviceLocationMode ?? 'PROVIDER_VISITS') ? null : params.jobLocation.address || null }),
        transportationFee: ['SEEKER_VISITS', 'REMOTE'].includes(params.serviceLocationMode ?? 'PROVIDER_VISITS') ? null : params.transportationFee,
        serviceLocationMode: params.serviceLocationMode,
        // Post Request always creates a public job, never a provider assignment.
        targetProviderId: null, targetServiceId: null,
        ...(paymentMethods && { paymentMethods }),
        status: "OPEN", moderationPolicyVersion: assessment.policyVersion,
      },
      include: {
        category: true,
        seeker: { select: { id: true, name: true, avatarUrl: true, trustScore: true, verificationStatus: true } },
      },
    });
    await tx.contentModerationEvent.create({ data: {
      actorId: seekerId, contentType: "SERVICE_REQUEST", resourceId: request.id,
      outcome: "PASS", reasonCode: assessment.reasonCode, policyVersion: assessment.policyVersion,
    } });
    await setListingPhotos(tx, seekerId, params.photoIds ?? [], { requestId: request.id });
    return withListingPhotos(await tx.serviceRequest.findUniqueOrThrow({ where: { id: request.id }, include: { ...listingPhotosInclude, category: true, seeker: { select: { id: true, name: true, avatarUrl: true, trustScore: true, verificationStatus: true } } } }));
  });
}

export function publicRequestWhere(providerId?: string): Prisma.ServiceRequestWhereInput {
  return {
      status: "OPEN",
      archivedAt: null,
      // A provider ID alone on an older public post must not restrict visibility.
      // Keep genuine listing inquiries limited to their participants.
      OR: [{ targetServiceId: null }, ...(providerId ? [{ targetProviderId: providerId }, { seekerId: providerId }] : [])],
      seeker: { isActive: true, moderationStatus: "ACTIVE", emailVerified: true, verificationStatus: "APPROVED" },
      // Legacy requests can still say OPEN after a booking was fulfilled.
      // Never advertise a request that has already produced a booking.
      offers: { none: { booking: { is: { status: { notIn: ["DECLINED", "CANCELED", "REMOVED"] } } } } },
  };
}

// targetServiceId is an application-managed scalar, not a Prisma relation.
async function inquiryServicePrices(requests: { targetServiceId: string | null }[]) {
  const ids = [...new Set(requests.flatMap(request => request.targetServiceId ? [request.targetServiceId] : []))];
  const services = ids.length ? await prisma.service.findMany({ where:{ id:{ in:ids } }, select:{ id:true, priceType:true, price:true } }) : [];
  return new Map(services.map(service => [service.id, {priceType:service.priceType,price:service.price}]));
}

export async function listRequests(categoryId?: string, providerId?: string, nearby?: NearbyQuery, ids?: string[]) {
  const requests = await prisma.serviceRequest.findMany({
    where: {
      ...publicRequestWhere(providerId),
      ...(ids && { id: { in: ids } }),
      ...(categoryId && { categoryId }),
      ...(nearby && { AND: [locationBounds(nearby), ...marketplaceSearchConditions(nearby.search)] }),
      ...(nearby?.category && nearby.category !== "All Categories" && { category: { name: { equals: canonicalCategoryName(nearby.category), mode: "insensitive" as const } } }),
    },
    include: {
      ...listingPhotosInclude,
      category: true,
      _count: { select: { offers: { where: { status: "PENDING" } } } },
      seeker: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          trustScore: true,
          verificationStatus: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const seekerIds = [...new Set(requests.map(request => request.seekerId))];
  if (!seekerIds.length) return [];
  // Batch all authors using the same counterparty/completion checks as profiles.
  const reviews = await prisma.$queryRaw<Array<{ targetId: string; rating: number; seekerId: string }>>(Prisma.sql`
    SELECT r."targetId", r.rating, cs."seekerId"
    FROM reviews r JOIN completed_services cs ON cs.id = r."completedServiceId"
    LEFT JOIN bookings b ON b.id = cs."bookingId"
    WHERE r."targetId" IN (${Prisma.join(seekerIds)})
      AND ${reviewEligibilitySql(Prisma.sql`r."targetId"`, 'seeker')}`);
  const stats = getSeekerReviewStats(reviews.map(review => ({
    ...review, completedService: { seekerId: review.seekerId },
  })));
  const sourcePrices = await inquiryServicePrices(requests);
  return requests.map(request => ({
    ...withListingPhotos(request),
    ...(request.targetServiceId && { targetService:sourcePrices.get(request.targetServiceId) ?? null }),
    offersCount: request._count.offers,
    targetProviderId: request.targetServiceId ? request.targetProviderId : null,
    seeker: { ...request.seeker, ...(stats.get(request.seekerId) ?? { clientRating: 0, clientReviewCount: 0 }) },
  }));
}

export async function getMyRequests(seekerId: string) {
  const requests = await prisma.serviceRequest.findMany({
    where: {
      seekerId,
      status: { not: "CANCELED" },
      archivedAt: null,
    },
    include: {
      ...listingPhotosInclude,
      category: true,
      offers: {
        include: {
          booking: { select: { status: true } },
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
      },
    },
    orderBy: { createdAt: "desc" },
  });
  // Once a booking exists, manage the work in Activity rather than the listing manager.
  // Unaccepted offers and pending payments without a booking remain here.
  const managedRequests = requests.filter(request => !request.offers.some(offer =>
    offer.booking && !['DECLINED', 'CANCELED', 'REMOVED'].includes(offer.booking.status)));
  const offerIds = managedRequests.flatMap(request => request.offers.map(offer => offer.id));
  const payments = offerIds.length ? await prisma.paymentAttempt.findMany({
    where: { offerId: { in: offerIds }, status: { in: protectedRequestPaymentStatuses } },
    select: { offerId: true, status: true },
  }) : [];
  const paymentsByOffer = new Map(payments.map(payment => [payment.offerId, payment]));
  const sourcePrices = await inquiryServicePrices(managedRequests);
  return managedRequests.map(request => ({
    ...withListingPhotos(request),
    ...(request.targetServiceId && { targetService:sourcePrices.get(request.targetServiceId) ?? null }),
    offers: request.offers.map(publicOffer),
    canArchive: canArchiveCompletedRequest(request.offers),
    ...requestDeletionEligibility(request, request.offers.flatMap(offer => {
      const payment = paymentsByOffer.get(offer.id);
      return payment ? [payment] : [];
    })),
  }));
}

export async function updateRequest(requestId: string, seekerId: string, params: {
  photoIds?: string[];
  title?: string;
  description?: string;
  budgetMin?: number;
  budgetMax?: number;
  status?: "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELED";
  urgency?: string;
  paymentMethods?: { cash: boolean; gcash: boolean };
  jobLocation?: JobLocation;
  serviceLocationMode?: ServiceLocationMode;
  transportationFee?: number | null;
}) {
  if (params.urgency !== undefined) RequestUrgencySchema.parse(params.urgency);
  if (params.paymentMethods !== undefined) RequestPaymentMethodsSchema.parse(params.paymentMethods);
  try {
  return await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${requestId}`}))`;
  await lockAccountLifecycle(tx, seekerId);
  await assertActiveMarketplaceAccount(tx, seekerId);
  const request = await tx.serviceRequest.findFirst({
    where: { id: requestId, seekerId },
  });

  if (!request) {
    const err = new Error("Request not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (request.archivedAt) throw Object.assign(new Error('An archived request cannot be edited or reopened. Repost it as a new request.'), { status: 409 });

  if (request.targetServiceId && Object.keys(params).some(key => key !== 'status')) {
    throw Object.assign(new Error('Cancel this service request and send a new one to change the work or location. Existing proposed prices must keep their original request details.'), { status: 409 });
  }

  if (request.targetServiceId && params.paymentMethods !== undefined) {
    throw Object.assign(new Error("The payment method for a direct service inquiry cannot be changed here."), { status: 409 });
  }

  if (!["OPEN", "CLOSED"].includes(request.status)) {
    const err = new Error("A matched, payment-pending, or completed request cannot be edited or reopened") as any;
    err.status = 409;
    throw err;
  }
  if (request.status === "CLOSED" && (params.status !== "OPEN" || Object.keys(params).some((key) => key !== "status"))) {
    const err = new Error("A paused request must be reopened before its details can be edited") as any;
    err.status = 409;
    throw err;
  }
  if (request.status === "CLOSED") {
    const linkedOffers = await tx.offer.findMany({ where: { requestId }, select: { id: true } });
    const offerIds = linkedOffers.map(offer => offer.id);
    const matched = offerIds.length ? await tx.booking.findFirst({
      where: { offerId: { in: offerIds }, status: { notIn: ["DECLINED", "CANCELED", "REMOVED"] } },
      select: { id: true },
    }) : null;
    const pendingPayment = offerIds.length ? await tx.paymentAttempt.findFirst({
      where: { offerId: { in: offerIds }, status: { in: ["PENDING", "SUCCEEDED", "REFUND_REQUIRED"] } },
      select: { id: true },
    }) : null;
    if (matched || pendingPayment) {
      const err = new Error("A fulfilled or payment-pending request cannot be reopened") as Error & { status?: number };
      err.status = 409;
      throw err;
    }
  }

  if (params.title !== undefined || params.description !== undefined || (request.status === "CLOSED" && params.status === "OPEN")) {
    const category = await tx.category.findUniqueOrThrow({ where: { id: request.categoryId }, select: { name: true } });
    const assessment = assessMarketplaceContent({
      kind: "SERVICE_REQUEST", categoryName: category.name,
      title: params.title ?? request.title, description: params.description ?? request.description,
    });
    if (assessment.outcome !== "PASS") {
      throw Object.assign(new Error(assessment.message), { status: 422, code: "CONTENT_REVISION_REQUIRED", moderationDecision: assessment, field: assessment.field });
    }
    await tx.contentModerationEvent.create({ data: {
      actorId: seekerId, contentType: "SERVICE_REQUEST", resourceId: requestId,
      outcome: assessment.outcome, reasonCode: assessment.reasonCode, policyVersion: assessment.policyVersion,
    } });
    await tx.serviceRequest.update({ where: { id: requestId }, data: { moderationPolicyVersion: assessment.policyVersion } });
  }

  const nextBudgetMin = params.budgetMin ?? Number(request.budgetMin);
  const nextBudgetMax = params.budgetMax ?? Number(request.budgetMax);
  if (!Number.isFinite(nextBudgetMin) || !Number.isFinite(nextBudgetMax) || nextBudgetMax < nextBudgetMin) {
    const err = new Error("budgetMax must be greater than or equal to budgetMin") as any;
    err.status = 400;
    throw err;
  }

  const { jobLocation, photoIds, ...changes } = params;
  // A legacy request can still be paused before its owner adds a wallet number.
  const closingOnly = params.status === 'CLOSED' && Object.keys(params).length === 1;
  if (!closingOnly) await assertListingGCashNumber(tx, seekerId, params.paymentMethods ?? request.paymentMethods);
  if (photoIds !== undefined) await setListingPhotos(tx, seekerId, photoIds, { requestId });
  assertLocationForArrangementChange(request.serviceLocationMode, params.serviceLocationMode, jobLocation, 'SEEKER_VISITS');
  if (jobLocation || params.transportationFee !== undefined || params.serviceLocationMode !== undefined) {
    const quoted = await tx.offer.findFirst({ where: { requestId, status: { in: ['PENDING', 'PENDING_PAYMENT', 'ACCEPTED'] } }, select: { id: true } });
    if (quoted) throw Object.assign(new Error('This request already has offers. Keep the agreed arrangement, location and travel budget, or post a new request.'), { status: 409 });
  }
  const changed = await tx.serviceRequest.updateMany({ where: { id: requestId, seekerId, status: request.status }, data: {
    ...changes, ...(jobLocation && { ...locationData(jobLocation), privateAddress: jobLocation.address || null }),
    ...(['SEEKER_VISITS', 'REMOTE'].includes(params.serviceLocationMode ?? request.serviceLocationMode) && { privateAddress: null, transportationFee: null }),
  } });
  if (changed.count !== 1) {
    const err = new Error("The request changed before it could be updated") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return withListingPhotos(await tx.serviceRequest.findUniqueOrThrow({ where: { id: requestId }, include: listingPhotosInclude }));
  });
  } catch (error) {
    const rejectedDecision = (error as { moderationDecision?: ContentDecision }).moderationDecision;
    if (rejectedDecision) await prisma.contentModerationEvent.create({ data: {
      actorId: seekerId, contentType: "SERVICE_REQUEST", resourceId: requestId,
      outcome: rejectedDecision.outcome, reasonCode: rejectedDecision.reasonCode, policyVersion: rejectedDecision.policyVersion,
    } });
    throw error;
  }
}

export async function cancelRequest(requestId: string, seekerId: string) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${requestId}`}))`;
    const request = await tx.serviceRequest.findFirst({ where: { id: requestId, seekerId } });
    if (!request) {
      const err = new Error("Request not found or access denied") as any;
      err.status = 404;
      throw err;
    }
    const offers = await tx.offer.findMany({ where: { requestId }, select: { id: true, providerId: true, status: true, booking: { select: { status: true } } } });
    const offerIds = offers.map((offer) => offer.id);
    const payments = offerIds.length === 0 ? [] : await tx.paymentAttempt.findMany({
      where: { offerId: { in: offerIds }, status: { in: protectedRequestPaymentStatuses } },
      select: { status: true },
    });
    const eligibility = requestDeletionEligibility({ ...request, offers }, payments);
    if (!eligibility.canDelete) {
      throw Object.assign(new Error(eligibility.deleteBlockedReason!), { status: 409, code: 'REQUEST_DELETE_BLOCKED' });
    }

    const changed = await tx.serviceRequest.updateMany({ where: { id: requestId, seekerId, status: "OPEN" }, data: { status: "CANCELED" } });
    if (changed.count !== 1) {
      const err = new Error("This request changed before it could be deleted. Review its latest status and try again.") as any;
      err.status = 409;
      err.code = "REQUEST_STATE_CHANGED";
      throw err;
    }
    await tx.offer.updateMany({ where: { requestId, status: "PENDING" }, data: { status: "REJECTED" } });
    const pending = [...new Map(offers.filter(offer => offer.status === 'PENDING').map(offer => [offer.providerId, offer])).values()];
    if (pending.length) await tx.notification.createMany({ data: pending.map(offer => ({
      id: `request-closed:${requestId}:${offer.providerId}`, userId: offer.providerId, title: 'Request closed',
      body: `The seeker closed "${request.title}". Your pending offer is now closed.`,
      link: `/provider/provider-activity?tab=all&offer=${offer.id}`,
    })) });
    return { request: await tx.serviceRequest.findUniqueOrThrow({ where: { id: requestId } }), providerIds: pending.map(offer => offer.providerId) };
  });
  publishNotifications(result.providerIds, 'Request closed');
  return result.request;
}

export async function archiveCompletedRequest(requestId: string, seekerId: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${requestId}`}))`;
    await lockAccountLifecycle(tx, seekerId);
    await assertActiveMarketplaceAccount(tx, seekerId);
    const request = await tx.serviceRequest.findFirst({
      where: { id: requestId, seekerId },
      include: { offers: { select: { status: true, booking: { select: { status: true } } } } },
    });
    if (!request) throw Object.assign(new Error('Request not found or access denied'), { status: 404 });
    if (!canArchiveCompletedRequest(request.offers)) {
      throw Object.assign(new Error('Only completed requests without an active booking can be archived.'), { status: 409 });
    }
    if (request.archivedAt) return request;
    return tx.serviceRequest.update({ where: { id: request.id }, data: { archivedAt: new Date() } });
  });
}

export async function getRequestRepostTemplate(requestId: string, seekerId: string) {
  const request = await prisma.serviceRequest.findFirst({
    where: { id: requestId, seekerId },
    include: { ...listingPhotosInclude, category: { select: { name: true, isActive: true } }, offers: { select: { status: true, booking: { select: { status: true } } } } },
  });
  if (!request) throw Object.assign(new Error('Request not found or access denied'), { status: 404 });
  if (request.targetServiceId || !canArchiveCompletedRequest(request.offers)) {
    throw Object.assign(new Error('Only completed public requests can be reposted.'), { status: 409 });
  }
  const paymentMethods = RequestPaymentMethodsSchema.safeParse(request.paymentMethods);
  return {
    title: request.title, description: request.description, photos: withListingPhotos(request).photos,
    categoryId: request.category.isActive ? request.categoryId : '', categoryName: request.category.name,
    jobLocation: request.latitude == null || request.longitude == null || !request.locationLabel ? undefined : { latitude: request.latitude, longitude: request.longitude, label: request.locationLabel, address: request.privateAddress || undefined },
    transportationFee: request.transportationFee == null ? null : Number(request.transportationFee),
    serviceLocationMode: request.serviceLocationMode,
    budget: Number(request.budgetMax), paymentMethods: paymentMethods.success ? paymentMethods.data : null,
  };
}
