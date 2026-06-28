import { prisma } from "../lib/prisma";

export async function submitOffer(providerId: string, params: {
  requestId: string;
  offeredPrice: number;
  estimatedDuration: number;
  availability?: string;
  message?: string;
}) {
  const { requestId, offeredPrice, estimatedDuration, availability, message } = params;

  // Check request is open
  const request = await prisma.serviceRequest.findUnique({
    where: { id: requestId },
    select: { status: true, seekerId: true },
  });

  if (!request || request.status !== "OPEN") {
    const err = new Error("Request is not open for offers") as any;
    err.status = 400;
    throw err;
  }

  // Prevent duplicate offer from same provider
  const existing = await prisma.offer.findFirst({
    where: { requestId, providerId, status: "PENDING" },
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
      body: `A provider submitted an offer of ₱${offeredPrice} on your request. Check Incoming Offers.`,
    },
  });

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

  // Accept this offer
  const updatedOffer = await prisma.offer.update({
    where: { id: offerId },
    data: { status: "ACCEPTED" },
  });

  // Auto-reject all other pending offers on this request (master prompt Section 5)
  await prisma.offer.updateMany({
    where: {
      requestId: offer.requestId,
      id: { not: offerId },
      status: "PENDING",
    },
    data: { status: "REJECTED" },
  });

  // Transition request status to IN_PROGRESS
  await prisma.serviceRequest.update({
    where: { id: offer.requestId },
    data: { status: "IN_PROGRESS" },
  });

  // Notify provider
  await prisma.notification.create({
    data: {
      userId: offer.providerId,
      title: "Offer Accepted! 🎉",
      body: `Your offer was accepted. Please proceed to payment to confirm your booking and queue position.`,
    },
  });

  return updatedOffer;
}

export async function rejectOffer(offerId: string, seekerId: string) {
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

  if (offer.request.seekerId !== seekerId) {
    const err = new Error("Not authorized") as any;
    err.status = 403;
    throw err;
  }

  return prisma.offer.update({
    where: { id: offerId },
    data: { status: "REJECTED" },
  });
}
