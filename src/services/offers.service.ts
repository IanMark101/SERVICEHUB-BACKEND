import { prisma } from "../lib/prisma";
import { assertDistinctAccounts } from "../utils/security";
import { safeEmit } from "../lib/socket";

export async function submitOffer(providerId: string, params: {
  requestId: string;
  serviceId: string;
  offeredPrice: number;
  estimatedDuration: number;
  availability?: string;
  message?: string;
}) {
  const { requestId, serviceId, offeredPrice, estimatedDuration, availability, message } = params;

  // Check request is open and accepting offers
  const request = await prisma.serviceRequest.findUnique({
    where: { id: requestId },
    select: { status: true, seekerId: true, categoryId: true },
  });

  if (!request || request.status !== "OPEN") {
    const err = new Error("This service request is currently paused or closed by the seeker and is no longer accepting new offers.") as any;
    err.status = 400;
    throw err;
  }

  // ── CRITICAL: Self-transaction prohibition (Spec Part 11) ──────────────────
  assertDistinctAccounts(providerId, request.seekerId, "submit offer");

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { providerId: true, categoryId: true, status: true, isAvailable: true, priceType: true },
  });
  if (!service || service.providerId !== providerId || service.categoryId !== request.categoryId || service.status !== "ACTIVE" || !service.isAvailable) {
    const err = new Error("Select one of your active listings in the request category before submitting an offer") as any;
    err.status = 400;
    throw err;
  }
  if (service.priceType !== "FIXED") {
    const err = new Error("Flow B payment currently requires a fixed-price provider listing") as any;
    err.status = 400;
    throw err;
  }

  // Prevent duplicate offer from same provider
  const existing = await prisma.offer.findFirst({
    where: { requestId, providerId, status: { in: ["PENDING", "PENDING_PAYMENT"] } },
  });

  if (existing) {
    const err = new Error("You have already submitted an offer for this request") as any;
    err.status = 409;
    throw err;
  }

  const offer = await prisma.offer.create({
    data: {
      requestId,
      providerId,
      serviceId,
      offeredPrice,
      estimatedDuration,
      availability,
      message,
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
  await prisma.notification.create({
    data: {
      userId: request.seekerId,
      title: "New Offer Received",
      body: `A provider submitted an offer of ₱${offeredPrice} on your request. Review it in Service Requests.`,
      link: `/seeker/incoming-offers?offer=${offer.id}`,
    },
  });
  safeEmit(`user:${request.seekerId}`, "notification", { title: "New Offer Received" });

  return offer;
}

export async function listReceivedOffers(seekerId: string) {
  const myRequests = await prisma.serviceRequest.findMany({
    where: { seekerId },
    select: { id: true },
  });
  const requestIds = myRequests.map((r) => r.id);

  return prisma.offer.findMany({
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
          title: true,
          status: true,
        },
      },
    },
    orderBy: [{ provider: { trustScore: "desc" } }, { createdAt: "asc" }],
  });
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

  if (offer.status !== "PENDING") {
    const err = new Error("Only a pending unpaid offer can be withdrawn or rejected") as any;
    err.status = 409;
    throw err;
  }

  const updatedOffer = await prisma.offer.update({
    where: { id: offerId },
    data: { status: isProvider ? "WITHDRAWN" : "REJECTED" },
  });

  // Real-time socket notification
  safeEmit(`user:${offer.request.seekerId}`, "ENGAGEMENT_CHANGED", { type: "offer_rejected", offerId });
  safeEmit(`user:${offer.providerId}`, "ENGAGEMENT_CHANGED", { type: "offer_rejected", offerId });

  return updatedOffer;
}
