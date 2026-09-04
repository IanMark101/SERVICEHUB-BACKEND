import { prisma } from "../lib/prisma";

export async function createRequest(seekerId: string, params: {
  categoryId: string;
  title: string;
  description: string;
  budgetMin: number;
  budgetMax: number;
  urgency: string;
}) {
  const { categoryId, title, description, budgetMin, budgetMax, urgency } = params;

  // Validate category exists and is active
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
  });

  if (!category || !category.isActive) {
    const err = new Error("Invalid or inactive category") as any;
    err.status = 400;
    throw err;
  }

  return prisma.serviceRequest.create({
    data: {
      seekerId,
      categoryId,
      title,
      description,
      budgetMin,
      budgetMax,
      urgency,
      status: "OPEN",
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
  });
}

export async function listRequests(categoryId?: string) {
  return prisma.serviceRequest.findMany({
    where: {
      status: "OPEN",
      seeker: { isActive: true, moderationStatus: "ACTIVE", emailVerified: true, verificationStatus: "APPROVED" },
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
}

export async function getMyRequests(seekerId: string) {
  return prisma.serviceRequest.findMany({
    where: {
      seekerId,
      status: { not: "CANCELED" },
    },
    include: {
      category: true,
      offers: {
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
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateRequest(requestId: string, seekerId: string, params: {
  title?: string;
  description?: string;
  budgetMin?: number;
  budgetMax?: number;
  status?: "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELED";
}) {
  const request = await prisma.serviceRequest.findFirst({
    where: { id: requestId, seekerId },
  });

  if (!request) {
    const err = new Error("Request not found or access denied") as any;
    err.status = 404;
    throw err;
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

  const nextBudgetMin = params.budgetMin ?? Number(request.budgetMin);
  const nextBudgetMax = params.budgetMax ?? Number(request.budgetMax);
  if (!Number.isFinite(nextBudgetMin) || !Number.isFinite(nextBudgetMax) || nextBudgetMax < nextBudgetMin) {
    const err = new Error("budgetMax must be greater than or equal to budgetMin") as any;
    err.status = 400;
    throw err;
  }

  return prisma.serviceRequest.update({
    where: { id: requestId },
    data: params,
  });
}

export async function cancelRequest(requestId: string, seekerId: string) {
  const request = await prisma.serviceRequest.findFirst({
    where: { id: requestId, seekerId },
  });

  if (!request) {
    const err = new Error("Request not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  if (request.status !== "OPEN") {
    const err = new Error("Only an open unmatched request can be cancelled directly") as any;
    err.status = 409;
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    await tx.offer.updateMany({ where: { requestId, status: "PENDING" }, data: { status: "REJECTED" } });
    return tx.serviceRequest.update({
      where: { id: requestId },
      data: { status: "CANCELED" },
    });
  });
}
