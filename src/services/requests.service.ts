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
      status: { in: ["OPEN", "IN_PROGRESS"] },
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
    where: { seekerId },
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

  return prisma.serviceRequest.update({
    where: { id: requestId },
    data: { status: "CANCELED" },
  });
}
