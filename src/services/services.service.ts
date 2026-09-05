import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import type { CreateServiceInput, UpdateServiceInput } from "../schema/services.schema";

const MAX_ACTIVE_LISTINGS = 3; // free-tier cap (master prompt Section 8)

export function normalizeServiceTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-PH");
}

function listingConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const conflict = new Error("You already have an active or pending listing with this title") as Error & { status?: number };
    conflict.status = 409;
    throw conflict;
  }
  throw error;
}

// ── Shared Marketplace Visibility Definition (Canonical Source of Truth) ──────
export const PUBLIC_SERVICE_WHERE = {
  status: "ACTIVE" as const,
  isAvailable: true,
  provider: {
    verificationStatus: "APPROVED" as const,
    isActive: true,
    moderationStatus: "ACTIVE" as const,
    emailVerified: true,
  },
};

async function attachEligibleProviderRatings<T extends { providerId: string; provider: Record<string, unknown> }>(services: T[]) {
  const providerIds = [...new Set(services.map((service) => service.providerId))];
  if (!providerIds.length) return services;
  const reviews = await prisma.review.findMany({
    where: {
      targetId: { in: providerIds },
      visibility: "VISIBLE",
      completedService: { providerId: { in: providerIds } },
    },
    select: { targetId: true, rating: true, completedService: { select: { providerId: true } } },
  });
  const byProvider = new Map<string, Array<{ rating: number }>>();
  for (const review of reviews) {
    if (review.targetId !== review.completedService.providerId) continue;
    const values = byProvider.get(review.targetId) ?? [];
    values.push({ rating: review.rating });
    byProvider.set(review.targetId, values);
  }
  return services.map((service) => ({
    ...service,
    provider: { ...service.provider, reviewsReceived: byProvider.get(service.providerId) ?? [] },
  }));
}

export async function getPublicServiceCount() {
  return prisma.service.count({
    where: PUBLIC_SERVICE_WHERE,
  });
}

export async function getActivePublicProviderCount() {
  return prisma.user.count({
    where: {
      verificationStatus: "APPROVED",
      isActive: true,
      moderationStatus: "ACTIVE",
      emailVerified: true,
      services: {
        some: {
          status: "ACTIVE",
          isAvailable: true,
        },
      },
    },
  });
}

export async function getRecentlyPublishedServices(limit = 6) {
  return prisma.service.findMany({
    where: PUBLIC_SERVICE_WHERE,
    orderBy: { updatedAt: "desc" }, // actual publication/approval timestamp
    take: limit,
    include: {
      category: { select: { id: true, name: true } },
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
}

// ── Browse (Public — ACTIVE listings only) ────────────────────────────────────

export async function browseServices(params: {
  categoryId?: string;
  search?: string;
  availableOnly?: boolean;
  excludeProviderId?: string;
}) {
  const { categoryId, search, availableOnly, excludeProviderId } = params;

  const services = await prisma.service.findMany({
    where: {
      ...PUBLIC_SERVICE_WHERE,
      ...(categoryId && { categoryId }),
      ...(availableOnly && { isAvailable: true }),
      ...(excludeProviderId && { providerId: { not: excludeProviderId } }),
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
      bookings: {
        where: { status: "ONGOING" },
        select: { id: true },
      },
    },
    orderBy: [{ provider: { trustScore: "desc" } }, { createdAt: "desc" }],
  });
  return attachEligibleProviderRatings(services);
}

// ── Get Single Service ─────────────────────────────────────────────────────────

export async function getServiceById(id: string) {
  const service = await prisma.service.findFirst({
    // This is a public endpoint. Draft, rejected, paused, and unverified
    // provider listings are available through authenticated owner/admin APIs,
    // never by guessing an ID here.
    where: { id, ...PUBLIC_SERVICE_WHERE },
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
        // Queue records contain seeker and payment data. Public service detail
        // pages need availability only, never identifiers or payment metadata.
        select: { position: true, estimatedWait: true },
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
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${providerId}`}))`;
      const activeCount = await tx.service.count({
        where: { providerId, status: { in: ["ACTIVE", "PENDING_REVIEW"] } },
      });
      if (activeCount >= MAX_ACTIVE_LISTINGS) {
        const error = new Error(`You can have at most ${MAX_ACTIVE_LISTINGS} active or pending service listings at a time`) as Error & { status?: number };
        error.status = 422;
        throw error;
      }

      const category = await tx.category.findFirst({
        where: { OR: [{ id: input.categoryId }, { name: input.categoryId }], isActive: true },
      });
      if (!category) {
        const error = new Error("Invalid or inactive category") as Error & { status?: number };
        error.status = 400;
        throw error;
      }

      const service = await tx.service.create({
        data: {
          providerId,
          categoryId: category.id,
          title: input.title,
          titleNormalized: normalizeServiceTitle(input.title),
          description: input.description,
          price: input.priceType === "CUSTOM" ? null : input.price!,
          priceType: input.priceType,
          serviceType: input.serviceType,
          estimatedDurationMins: input.estimatedDurationMins,
          queueLimit: input.queueLimit,
          paymentMethods: input.paymentMethods,
          status: "PENDING_REVIEW",
          isAvailable: false,
        },
        include: { category: true, provider: { select: { id: true, name: true, email: true } } },
      });

      await tx.notification.create({
        data: { userId: providerId, title: "Listing Submitted for Review", body: `Your service listing "${input.title}" was submitted and is pending admin review.`, link: "/provider/service-manager?status=pending" },
      });
      const admins = await tx.user.findMany({ where: { role: "admin", isActive: true, moderationStatus: "ACTIVE" }, select: { id: true } });
      if (admins.length) {
        await tx.notification.createMany({ data: admins.map((admin) => ({ userId: admin.id, title: "New Service Listing Pending Review", body: `${service.provider.name} submitted a new listing: "${input.title}".`, link: "/admin/services" })) });
      }
      return { service, admins };
    });
  } catch (error) {
    listingConflict(error);
  }

  safeEmit(`user:${providerId}`, "notification", { title: "Listing Submitted for Review" });
  created.admins.forEach((admin) => safeEmit(`user:${admin.id}`, "notification", { title: "New Service Listing Pending Review", link: "/admin/services" }));
  safeEmit("admin", "SERVICE_LISTING_SUBMITTED", { serviceId: created.service.id });
  return created.service;
}


export async function updateService(serviceId: string, providerId: string, input: UpdateServiceInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${providerId}`}))`;
      const service = await tx.service.findFirst({ where: { id: serviceId, providerId, status: { not: "DELETED" } } });
      if (!service) {
        const error = new Error("Service not found or access denied") as Error & { status?: number };
        error.status = 404;
        throw error;
      }

      let categoryId = service.categoryId;
      if (service.status === 'SUSPENDED') {
        throw Object.assign(new Error('An administrator must restore this suspended listing before it can be edited'), { status: 409 });
      }
      if (input.categoryId) {
        const category = await tx.category.findFirst({ where: { id: input.categoryId, isActive: true }, select: { id: true } });
        if (!category) {
          const error = new Error("Invalid or inactive category") as Error & { status?: number };
          error.status = 400;
          throw error;
        }
        categoryId = category.id;
      }

      const nextTitle = input.title ?? service.title;
      const nextPriceType = input.priceType ?? service.priceType;
      const nextPrice = nextPriceType === "CUSTOM" ? null : input.price ?? service.price;
      if (nextPriceType !== "CUSTOM" && nextPrice === null) {
        const error = new Error("A price is required when changing from custom pricing") as Error & { status?: number };
        error.status = 400;
        throw error;
      }

      const materialChanged = normalizeServiceTitle(nextTitle) !== service.titleNormalized
        || categoryId !== service.categoryId
        || (input.description !== undefined && input.description !== service.description)
        || service.status === "REJECTED";

      if (materialChanged && !["ACTIVE", "PENDING_REVIEW"].includes(service.status)) {
        const occupied = await tx.service.count({ where: { providerId, status: { in: ["ACTIVE", "PENDING_REVIEW"] } } });
        if (occupied >= MAX_ACTIVE_LISTINGS) {
          throw Object.assign(new Error("Archive a listing before resubmitting another for review"), { status: 422 });
        }
      }

      return tx.service.update({
        where: { id: serviceId },
        data: {
          ...input,
          title: nextTitle,
          titleNormalized: normalizeServiceTitle(nextTitle),
          categoryId,
          price: nextPrice,
          ...(materialChanged && { status: "PENDING_REVIEW", isAvailable: false, reviewedById: null, reviewedAt: null }),
        },
        include: { category: true },
      });
    });
  } catch (error) {
    listingConflict(error);
  }
}


export async function toggleServiceAvailability(serviceId: string, providerId: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${providerId}`}))`;
      const service = await tx.service.findFirst({ where: { id: serviceId, providerId, status: { in: ['ACTIVE', 'INACTIVE'] } } });
      if (!service) throw Object.assign(new Error('Only an approved listing can be paused or resumed'), { status: 404 });
      const resume = service.status === 'INACTIVE' || !service.isAvailable;
      if (resume) {
        const occupied = await tx.service.count({ where: { providerId, id: { not: serviceId }, status: { in: ['ACTIVE', 'PENDING_REVIEW'] } } });
        if (occupied >= MAX_ACTIVE_LISTINGS) throw Object.assign(new Error('Pause or archive another listing before resuming this one'), { status: 422 });
      }
      return tx.service.update({ where: { id: serviceId }, data: { status: resume ? 'ACTIVE' : 'INACTIVE', isAvailable: resume } });
    });
  } catch (error) { listingConflict(error); }
}

// ── Delete Listing (Hard Erase from DB) ───────────────────────────────────────

export async function deleteService(serviceId: string, providerId: string) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, providerId },
  });

  if (!service) {
    const err = new Error("Service not found or access denied") as any;
    err.status = 404;
    throw err;
  }

  // A listing with active work cannot be erased: deleting its queue rows would
  // orphan a paid booking and leave its payment state unresolved.
  const activeBooking = await prisma.booking.findFirst({
    where: {
      serviceId,
      status: { in: ["PENDING_APPROVAL", "WAITING", "ACCEPTED", "ONGOING", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"] },
    },
    select: { id: true },
  });
  if (activeBooking) {
    const err = new Error("Cannot delete a service with an active booking. Pause the listing and finish or cancel its bookings first.") as any;
    err.status = 409;
    throw err;
  }

  await prisma.queueNotify.deleteMany({ where: { serviceId } });
  return prisma.service.update({
    where: { id: serviceId },
    data: { status: "DELETED", isAvailable: false },
  });
}

// ── Get My Listings (Provider) ─────────────────────────────────────────────────

export async function getMyServices(providerId: string) {
  const services = await prisma.service.findMany({
    where: { providerId, status: { not: "DELETED" } },
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
    orderBy: { createdAt: "desc" },
  });
  return attachEligibleProviderRatings(services);
}

// ── Admin: List Pending Services ───────────────────────────────────────────────

export async function listPendingServices(page = 1, limit = 20) {
  const where = { status: "PENDING_REVIEW" as const };
  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      include: {
        provider: {
          select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true },
        },
        category: true,
      },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.service.count({ where }),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}


