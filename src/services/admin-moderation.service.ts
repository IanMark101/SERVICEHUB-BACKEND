import { prisma } from "../lib/prisma";
import { safeEmit, safeBroadcast } from "../lib/socket";

export async function reviewServiceListing(
  serviceId: string,
  adminId: string,
  approve: boolean,
  adminNotes?: string,
) {
  const result = await prisma.$transaction(async (tx) => {
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
      notificationBody = `Your service "${service.title}" is now live and visible to seekers.`;
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
        const rows = await tx.$queryRaw<Array<{ trustScore: number }>>`
          SELECT "trustScore" FROM "users" WHERE "id" = ${service.providerId} FOR UPDATE
        `;
        const scoreBefore = rows[0].trustScore;
        const scoreAfter = Math.max(0, scoreBefore - 5);
        await tx.user.update({ where: { id: service.providerId }, data: { trustScore: scoreAfter } });
        await tx.trustScoreEvent.create({
          data: {
            userId: service.providerId,
            delta: scoreAfter - scoreBefore,
            reason: "Second repeated service listing rejection",
            scoreBefore,
            scoreAfter,
            actorAdminId: adminId,
          },
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
