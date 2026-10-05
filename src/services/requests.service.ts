import { prisma } from "../lib/prisma";
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from "./account-lifecycle.service";
import { assessMarketplaceContent, type ContentDecision } from "./content-moderation.service";
import { RequestPaymentMethodsSchema, RequestUrgencySchema } from "../schema/marketplace.schema";
import { getSeekerReviewStats } from "../lib/seeker-review-stats";
import { protectedRequestPaymentStatuses, requestDeletionEligibility } from "../lib/request-deletion";

export async function createRequest(seekerId: string, params: {
  categoryId: string;
  title: string;
  description: string;
  budgetMin: number;
  budgetMax: number;
  urgency: string;
  paymentMethods?: { cash: boolean; gcash: boolean };
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
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seeker-requests:${seekerId}`}))`;
    const activeRequests = await tx.serviceRequest.findMany({
      where: { seekerId, categoryId, status: { in: ["OPEN", "PAYMENT_PENDING", "IN_PROGRESS"] } },
      select: { title: true },
    });
    const normalizedTitle = title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (activeRequests.some((item) => item.title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase() === normalizedTitle)) {
      throw Object.assign(new Error("You already have an active request with this title and category."), { status: 409, code: "DUPLICATE_REQUEST" });
    }

    const request = await tx.serviceRequest.create({
      data: {
        seekerId, categoryId, title, description, budgetMin, budgetMax, urgency,
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
    return request;
  });
}

export async function listRequests(categoryId?: string, providerId?: string) {
  const requests = await prisma.serviceRequest.findMany({
    where: {
      status: "OPEN",
      // A provider ID alone on an older public post must not restrict visibility.
      // Keep genuine listing inquiries limited to their participants.
      OR: [{ targetServiceId: null }, ...(providerId ? [{ targetProviderId: providerId }, { seekerId: providerId }] : [])],
      seeker: { isActive: true, moderationStatus: "ACTIVE", emailVerified: true, verificationStatus: "APPROVED" },
      // Legacy requests can still say OPEN after a booking was fulfilled.
      // Never advertise a request that has already produced a booking.
      offers: { none: { booking: { is: { status: { notIn: ["DECLINED", "CANCELED", "REMOVED"] } } } } },
      ...(categoryId && { categoryId }),
    },
    include: {
      category: true,
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
  if (!seekerIds.length) return requests;
  const reviews = await prisma.review.findMany({
    where: {
      targetId: { in: seekerIds },
      visibility: "VISIBLE",
      completedService: { seekerId: { in: seekerIds } },
    },
    select: { targetId: true, rating: true, completedService: { select: { seekerId: true } } },
  });
  const stats = getSeekerReviewStats(reviews);
  return requests.map(request => ({
    ...request,
    targetProviderId: request.targetServiceId ? request.targetProviderId : null,
    seeker: { ...request.seeker, ...(stats.get(request.seekerId) ?? { clientRating: 0, clientReviewCount: 0 }) },
  }));
}

export async function getMyRequests(seekerId: string) {
  const requests = await prisma.serviceRequest.findMany({
    where: {
      seekerId,
      status: { not: "CANCELED" },
    },
    include: {
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
  const offerIds = requests.flatMap(request => request.offers.map(offer => offer.id));
  const payments = offerIds.length ? await prisma.paymentAttempt.findMany({
    where: { offerId: { in: offerIds }, status: { in: protectedRequestPaymentStatuses } },
    select: { offerId: true, status: true },
  }) : [];
  const paymentsByOffer = new Map(payments.map(payment => [payment.offerId, payment]));
  return requests.map(request => ({
    ...request,
    ...requestDeletionEligibility(request, request.offers.flatMap(offer => {
      const payment = paymentsByOffer.get(offer.id);
      return payment ? [payment] : [];
    })),
  }));
}

export async function updateRequest(requestId: string, seekerId: string, params: {
  title?: string;
  description?: string;
  budgetMin?: number;
  budgetMax?: number;
  status?: "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELED";
  urgency?: string;
  paymentMethods?: { cash: boolean; gcash: boolean };
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

  const changed = await tx.serviceRequest.updateMany({ where: { id: requestId, seekerId, status: request.status }, data: params });
  if (changed.count !== 1) {
    const err = new Error("The request changed before it could be updated") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return tx.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
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
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`request:${requestId}`}))`;
    const request = await tx.serviceRequest.findFirst({ where: { id: requestId, seekerId } });
    if (!request) {
      const err = new Error("Request not found or access denied") as any;
      err.status = 404;
      throw err;
    }
    const offers = await tx.offer.findMany({ where: { requestId }, select: { id: true, status: true, booking: { select: { status: true } } } });
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
    return tx.serviceRequest.findUniqueOrThrow({ where: { id: requestId } });
  });
}
