import { prisma } from "../lib/prisma";
import { applyListingRejectionTrust } from "./trust.service";
import type { CreateServiceInput, UpdateServiceInput } from "../schema/services.schema";

const MAX_ACTIVE_LISTINGS = 3; // free-tier cap (master prompt Section 8)

// ── Browse (Public — ACTIVE listings only) ────────────────────────────────────

export async function browseServices(params: {
  categoryId?: string;
  search?: string;
  availableOnly?: boolean;
}) {
  const { categoryId, search, availableOnly } = params;

  return prisma.service.findMany({
    where: {
      status: "ACTIVE",
      isAvailable: true,
      ...(categoryId && { categoryId }),
      ...(availableOnly && { isAvailable: true }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ],
      }),
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
      category: { select: { id: true, name: true } },
      queueEntries: {
        where: { status: { in: ["WAITING", "SERVING"] } },
        select: { id: true, position: true },
      },
    },
    orderBy: [{ provider: { trustScore: "desc" } }, { createdAt: "desc" }],
  });
}

// ── Get Single Service ─────────────────────────────────────────────────────────

export async function getServiceById(id: string) {
  const service = await prisma.service.findUnique({
    where: { id },
    include: {
      provider: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          trustScore: true,
          verificationStatus: true,
          bio: true,
        },
      },
      category: true,
      queueEntries: {
        where: { status: { in: ["WAITING", "SERVING"] } },
        orderBy: { position: "asc" },
      },
    },
  });

  if (!service) {
    const err = new Error("Service not found") as any;
    err.status = 404;
    throw err;
  }

  return service;
}

// ── Create Listing (always starts PENDING_REVIEW) ─────────────────────────────

export async function createService(providerId: string, input: CreateServiceInput) {
  // 1. Enforce 3-listing cap for free-tier
  const activeCount = await prisma.service.count({
    where: { providerId, status: { in: ["ACTIVE", "PENDING_REVIEW", "INACTIVE"] } },
  });

  if (activeCount >= MAX_ACTIVE_LISTINGS) {
    const err = new Error(
      `You can have at most ${MAX_ACTIVE_LISTINGS} active service listings at a time`
    ) as any;
    err.status = 422;
    throw err;
  }

  // 2. Duplicate title check (case-insensitive — DB unique constraint also guards this)
  const duplicate = await prisma.service.findFirst({
    where: {
      providerId,
      title: { equals: input.title, mode: "insensitive" },
      status: { not: "DELETED" },
    },
  });

  if (duplicate) {
    const err = new Error("You already have a listing with this title") as any;
    err.status = 409;
    throw err;
  }

  // 3. Validate category exists and is active
  const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
  if (!category || !category.isActive) {
    const err = new Error("Invalid or inactive category") as any;
    err.status = 400;
    throw err;
  }

  return prisma.service.create({
    data: {
      providerId,
      categoryId: input.categoryId,
      title: input.title,
      description: input.description,
      price: input.price,
      priceType: input.priceType,
      estimatedDurationMins: input.estimatedDurationMins,
      queueLimit: input.queueLimit,
      paymentMethods: input.paymentMethods,
      status: "PENDING_REVIEW", // ALWAYS — never goes live without admin approval
      isAvailable: false,
    },
    include: { category: true },
  });
}

// ── Update Listing ─────────────────────────────────────────────────────────────

export async function updateService(
  serviceId: string,
  providerId: string,
  input: UpdateServiceInput
) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, providerId, status: { not: "DELETED" } },
  });

  if (!service) {
    const err = new Error("Service not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  // Changing title or category re-triggers PENDING_REVIEW (master prompt Section 8)
  const titleChanged = input.title && input.title.toLowerCase() !== service.title.toLowerCase();
  const categoryChanged = input.categoryId && input.categoryId !== service.categoryId;
  const requiresReReview = titleChanged || categoryChanged;

  return prisma.service.update({
    where: { id: serviceId },
    data: {
      ...input,
      ...(requiresReReview && { status: "PENDING_REVIEW", isAvailable: false }),
    },
    include: { category: true },
  });
}

// ── Toggle Pause/Active ────────────────────────────────────────────────────────

export async function toggleServiceAvailability(serviceId: string, providerId: string) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, providerId, status: "ACTIVE" },
  });

  if (!service) {
    const err = new Error("Service not found, not yours, or not active") as any;
    err.status = 404;
    throw err;
  }

  return prisma.service.update({
    where: { id: serviceId },
    data: { isAvailable: !service.isAvailable },
  });
}

// ── Delete Listing (soft delete) ───────────────────────────────────────────────

export async function deleteService(serviceId: string, providerId: string) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, providerId, status: { not: "DELETED" } },
  });

  if (!service) {
    const err = new Error("Service not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  return prisma.service.update({
    where: { id: serviceId },
    data: { status: "DELETED", isAvailable: false },
  });
}

// ── Get My Listings (Provider) ─────────────────────────────────────────────────

export async function getMyServices(providerId: string) {
  return prisma.service.findMany({
    where: { providerId, status: { not: "DELETED" } },
    include: {
      category: { select: { id: true, name: true } },
      queueEntries: {
        where: { status: { in: ["WAITING", "SERVING"] } },
        select: { id: true, position: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

// ── Admin: List Pending Services ───────────────────────────────────────────────

export async function listPendingServices() {
  return prisma.service.findMany({
    where: { status: "PENDING_REVIEW" },
    include: {
      provider: {
        select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true },
      },
      category: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

// ── Admin: Approve or Reject Service Listing ──────────────────────────────────

export async function adminReviewService(
  serviceId: string,
  adminId: string,
  approve: boolean,
  adminNotes?: string
) {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { provider: true },
  });

  if (!service) {
    const err = new Error("Service not found") as any;
    err.status = 404;
    throw err;
  }

  if (approve) {
    // Check that provider is verified (APPROVED) — unverified providers can draft but not get approved
    if (service.provider.verificationStatus !== "APPROVED") {
      const err = new Error(
        "Provider must be a Verified Resident before their listing can be approved"
      ) as any;
      err.status = 422;
      throw err;
    }

    await prisma.service.update({
      where: { id: serviceId },
      data: { status: "ACTIVE", isAvailable: true, adminNotes: adminNotes || null },
    });

    await prisma.notification.create({
      data: {
        userId: service.providerId,
        title: "Listing Approved ✅",
        body: `Your service "${service.title}" is now live and visible to seekers.`,
      },
    });
  } else {
    // Rejection logic — track count, escalate on repeated rejections
    const newRejectionCount = service.rejectionCount + 1;
    let notifBody = `Your service listing "${service.title}" was not approved. Reason: ${adminNotes || "Please review and resubmit."}`;

    await prisma.service.update({
      where: { id: serviceId },
      data: {
        status: "REJECTED",
        isAvailable: false,
        rejectionCount: newRejectionCount,
        adminNotes: adminNotes || null,
      },
    });

    // 2nd rejection: trust -5
    if (newRejectionCount === 2) {
      await applyListingRejectionTrust(service.providerId, 2);
      notifBody += " (Trust score reduced due to repeated rejections.)";
    }

    // 3rd+ rejection: flag account for admin review, suspend posting
    if (newRejectionCount >= 3) {
      await prisma.user.update({
        where: { id: service.providerId },
        data: { isActive: false }, // posting suspended — admin must manually restore
      });
      notifBody += " Your account has been flagged for admin review.";
    }

    await prisma.notification.create({
      data: {
        userId: service.providerId,
        title: "Listing Rejected",
        body: notifBody,
      },
    });
  }

  return { approved: approve };
}
