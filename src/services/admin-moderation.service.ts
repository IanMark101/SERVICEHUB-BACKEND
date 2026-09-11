import { prisma } from "../lib/prisma";
import { safeEmit, safeBroadcast } from "../lib/socket";
import { applyTrustEventInTransaction } from "./trust.service";

export async function reviewServiceListing(
  serviceId: string,
  adminId: string,
  approve: boolean,
  adminNotes?: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    const owner = await tx.service.findUnique({ where: { id: serviceId }, select: { providerId: true } });
    if (owner) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${owner.providerId}`}))`;
    const service = await tx.service.findUnique({
      where: { id: serviceId },
      include: { provider: true },
    });
    if (!service) {
      const error = new Error("Service not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    if (service.status !== "PENDING_REVIEW") {
      const error = new Error("Service listing has already been reviewed") as Error & { status?: number };
      error.status = 409;
      throw error;
    }
    if (approve && service.provider.verificationStatus !== "APPROVED") {
      const error = new Error("Provider must be a Verified Resident before approval") as Error & { status?: number };
      error.status = 422;
      throw error;
    }

    let notificationBody: string;
    if (approve) {
      const claimed = await tx.service.updateMany({
        where: { id: serviceId, status: "PENDING_REVIEW" },
        data: {
          status: "ACTIVE",
          isAvailable: true,
          adminNotes: adminNotes || null,
          reviewedById: adminId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        const error = new Error("Service listing has already been reviewed") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      notificationBody = `Your service "${service.title}" is now live and visible to seekers. Administrator note: ${adminNotes}`;
    } else {
      const rejectionCount = service.rejectionCount + 1;
      const claimed = await tx.service.updateMany({
        where: { id: serviceId, status: "PENDING_REVIEW" },
        data: {
          status: "REJECTED",
          isAvailable: false,
          rejectionCount,
          adminNotes,
          reviewedById: adminId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        const error = new Error("Service listing has already been reviewed") as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      notificationBody = `Your service "${service.title}" was not approved. Reason: ${adminNotes}`;

      if (rejectionCount === 2) {
        await applyTrustEventInTransaction(tx, {
          userId: service.providerId,
          delta: -5,
          reason: "Second repeated service listing rejection",
          actorAdminId: adminId,
          eventKey: `listing-rejection:${service.id}:2`,
        });
        notificationBody += " Your trust score was reduced by 5 points.";
      }

      if (rejectionCount >= 3) {
        await tx.user.update({
          where: { id: service.providerId },
          data: {
            postingSuspended: true,
            postingSuspendedAt: new Date(),
            postingSuspendReason: "Three or more rejected service listings",
          },
        });
        notificationBody += " Your service-listing privilege is suspended pending administrator review.";
      }
    }

    await tx.notification.create({
      data: {
        userId: service.providerId,
        title: approve ? "Listing Approved" : "Listing Rejected",
        body: notificationBody,
        link: `/provider/service-manager?id=${service.id}&status=${approve ? "active" : "rejected"}`,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: adminId,
        targetUserId: service.providerId,
        action: approve ? "SERVICE_APPROVED" : "SERVICE_REJECTED",
        resourceType: "Service",
        resourceId: service.id,
        reason: adminNotes || "Listing meets marketplace requirements",
        metadata: { rejectionCount: approve ? service.rejectionCount : service.rejectionCount + 1 },
      },
    });
    return service;
  });

  safeEmit(`user:${result.providerId}`, "notification", { title: approve ? "Listing Approved" : "Listing Rejected" });
  safeBroadcast("SERVICE_LISTINGS_CHANGED", { id: serviceId, status: approve ? "ACTIVE" : "REJECTED" });
  return { approved: approve };
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
