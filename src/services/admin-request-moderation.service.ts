import { prisma } from "../lib/prisma";
import { applyPublicContentAction, emitPublicContentAction } from "./public-content-actions.service";

export async function listAdminPublicRequests(page: number, limit: number) {
  const where = { status: "OPEN" as const };
  const [items, total] = await Promise.all([
    prisma.serviceRequest.findMany({
      where,
      include: {
        seeker: { select: { id: true, name: true, email: true } },
        category: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit,
    }),
    prisma.serviceRequest.count({ where }),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function removePublicRequest(id: string, adminId: string, reason: string) {
  const result = await prisma.$transaction(tx => applyPublicContentAction(tx, "SERVICE_REQUEST", id, adminId, "REMOVE", reason));
  emitPublicContentAction(result);
  return prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
}
