import { prisma } from "../lib/prisma";
import { safeEmit, safeBroadcast } from "../lib/socket";
import { applyPublicContentAction, emitPublicContentAction } from "./public-content-actions.service";
export async function removePublishedService(id: string, adminId: string, reason: string) {
  const result = await prisma.$transaction(tx => applyPublicContentAction(tx, "SERVICE_LISTING", id, adminId, "REMOVE", reason));
  emitPublicContentAction(result);
  return prisma.service.findUniqueOrThrow({ where: { id } });
}
export async function restoreRemovedService(id: string, adminId: string, reason: string) {
  const result = await prisma.$transaction(tx => applyPublicContentAction(tx, "SERVICE_LISTING", id, adminId, "RESTORE", reason));
  emitPublicContentAction(result);
  return prisma.service.findUniqueOrThrow({ where: { id } });
}

export async function resolveCategory(
  suggestionId: string,
  adminId: string,
  approve: boolean,
  adminNotes?: string,
) {
  const suggestion = await prisma.$transaction(async (tx) => {
    const current = await tx.categorySuggested.findUnique({ where: { id: suggestionId } });
    if (!current) {
      const error = new Error("Category suggestion not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    if (current.status !== "PENDING") {
      const error = new Error("Category suggestion has already been reviewed") as Error & { status?: number };
      error.status = 409;
      throw error;
    }

    const normalizedName = current.name.trim().replace(/\s+/g, " ");
    if (approve) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(lower(${normalizedName})))`;
      const duplicate = await tx.category.findFirst({
        where: { name: { equals: normalizedName, mode: "insensitive" } },
        select: { id: true },
      });
      if (duplicate) {
        const error = new Error("An equivalent category already exists") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      await tx.category.create({ data: { name: normalizedName, isActive: true } });
    }

    const claimed = await tx.categorySuggested.updateMany({
      where: { id: suggestionId, status: "PENDING" },
      data: {
        name: normalizedName,
        status: approve ? "APPROVED" : "REJECTED",
        reviewedAt: new Date(),
        reviewedById: adminId,
        adminNotes: adminNotes || null,
      },
    });
    if (claimed.count !== 1) {
      const error = new Error("Category suggestion has already been reviewed") as Error & { status?: number };
      error.status = 409;
      throw error;
    }
    await tx.notification.create({
      data: {
        userId: current.submitterId,
        title: approve ? `Category "${normalizedName}" Approved` : "Category Suggestion Not Approved",
        body: approve
          ? `Your suggested category "${normalizedName}" is now available in the marketplace.`
          : `Your suggested category was not approved. Reason: ${adminNotes}`,
        link: "/seeker/suggest-category",
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: adminId,
        targetUserId: current.submitterId,
        action: approve ? "CATEGORY_APPROVED" : "CATEGORY_REJECTED",
        resourceType: "CategorySuggested",
        resourceId: suggestionId,
        reason: adminNotes || "Category fits the local-service marketplace",
      },
    });
    return tx.categorySuggested.findUniqueOrThrow({ where: { id: suggestionId } });
  });

  safeEmit(`user:${suggestion.submitterId}`, "notification", {
    title: approve ? "Category Suggestion Approved" : "Category Suggestion Rejected",
  });
  safeBroadcast("COMMUNITY_CATEGORIES_CHANGED", { id: suggestion.id, approved: approve });
  return suggestion;
}

export async function listManagedCategories(page: number, limit: number) {
  const [categories, total] = await prisma.$transaction([
    prisma.category.findMany({
      orderBy: { name: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        isActive: true,
        _count: {
          select: {
            services: { where: { status: { not: "DELETED" } } },
            serviceRequests: true,
          },
        },
      },
    }),
    prisma.category.count(),
  ]);

  const categoryIds = categories.map(({ id }) => id);
  const [liveListingGroups, openRequestGroups] = categoryIds.length === 0
    ? [[], []]
    : await Promise.all([
        prisma.service.groupBy({
          by: ["categoryId"],
          where: { categoryId: { in: categoryIds }, status: "ACTIVE" },
          _count: { _all: true },
        }),
        prisma.serviceRequest.groupBy({
          by: ["categoryId"],
          where: { categoryId: { in: categoryIds }, status: { in: ["OPEN", "PAYMENT_PENDING", "IN_PROGRESS"] } },
          _count: { _all: true },
        }),
      ]);
  const liveListingCounts = new Map(liveListingGroups.map((group) => [group.categoryId, group._count._all]));
  const openRequestCounts = new Map(openRequestGroups.map((group) => [group.categoryId, group._count._all]));

  return {
    items: categories.map(({ _count, ...category }) => ({
      ...category,
      listingCount: _count.services,
      liveListingCount: liveListingCounts.get(category.id) ?? 0,
      requestCount: _count.serviceRequests,
      openRequestCount: openRequestCounts.get(category.id) ?? 0,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function updateManagedCategory(
  categoryId: string,
  adminId: string,
  input: { name?: string; isActive?: boolean; reason: string },
) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`category:${categoryId}`}))`;
    const current = await tx.category.findUnique({ where: { id: categoryId } });
    if (!current) {
      const error = new Error("Category not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    }

    const nextName = input.name?.trim().replace(/\s+/g, " ") ?? current.name;
    const nextIsActive = input.isActive ?? current.isActive;
    if (nextName === current.name && nextIsActive === current.isActive) {
      const error = new Error("No category changes were provided") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    if (nextName.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(lower(${nextName})))`;
      const duplicate = await tx.category.findFirst({
        where: { id: { not: categoryId }, name: { equals: nextName, mode: "insensitive" } },
        select: { id: true },
      });
      if (duplicate) {
        const error = new Error("An equivalent category already exists") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
    }

    const [listingCount, openRequestCount] = await Promise.all([
      tx.service.count({ where: { categoryId, status: { not: "DELETED" } } }),
      tx.serviceRequest.count({
        where: { categoryId, status: { in: ["OPEN", "PAYMENT_PENDING", "IN_PROGRESS"] } },
      }),
    ]);
    if (current.isActive && !nextIsActive && (listingCount > 0 || openRequestCount > 0)) {
      const error = new Error(
        `Category cannot be deactivated while ${listingCount} marketplace listing(s) or ${openRequestCount} open request(s) depend on it`,
      ) as Error & { status?: number };
      error.status = 409;
      throw error;
    }

    const category = await tx.category.update({
      where: { id: categoryId },
      data: { name: nextName, isActive: nextIsActive },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: "CATEGORY_UPDATED",
        resourceType: "Category",
        resourceId: categoryId,
        reason: input.reason,
        metadata: {
          before: { name: current.name, isActive: current.isActive },
          after: { name: category.name, isActive: category.isActive },
          listingCount,
          openRequestCount,
        },
      },
    });
    return category;
  });

  safeBroadcast("COMMUNITY_CATEGORIES_CHANGED", { id: result.id, updated: true });
  safeBroadcast("SERVICE_LISTINGS_CHANGED", { categoryId: result.id, categoryUpdated: true });
  return result;
}

export async function createManagedCategory(adminId: string, input: { name: string; reason: string }) {
  const name = input.name.trim().replace(/\s+/g, " ");
  const category = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(lower(${name})))`;
    const existing = await tx.category.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (existing) throw Object.assign(new Error("An equivalent category already exists"), { status: 409 });
    const created = await tx.category.create({ data: { name, isActive: true } });
    await tx.adminAuditLog.create({ data: { actorId: adminId, action: "CATEGORY_CREATED", resourceType: "Category", resourceId: created.id, reason: input.reason } });
    return created;
  });
  safeBroadcast("COMMUNITY_CATEGORIES_CHANGED", { id: category.id, created: true });
  return category;
}
