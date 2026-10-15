import { locationData, locationBounds, publicLocation } from '../lib/proximity';
import { listingPhotosInclude, withListingPhotos } from '../lib/listing-photos';
import { setListingPhotos } from './listing-photos.service';
import { assertLocationForArrangementChange } from '../lib/service-arrangement';
import type { NearbyQuery } from '../schema/location.schema';
import { marketplaceSearchConditions } from '../lib/marketplace-search';
import { canonicalCategoryName } from '../lib/category-catalog';
import { Prisma, ServiceStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from "./account-lifecycle.service";
import { assertListingGCashNumber } from './gcash-listing-policy';
import { safeBroadcast, safeEmit } from "../lib/socket";
import type { CreateServiceInput, UpdateServiceInput } from "../schema/services.schema";
import { assessMarketplaceContent, type ContentDecision } from "./content-moderation.service";
import { RATE_PRICE_TYPES, validListingPrice } from '../lib/listing-pricing';

const MAX_ACTIVE_LISTINGS = 3; // free-tier cap (master prompt Section 8)

export function normalizeServiceTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-PH");
}

function listingConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const conflict = new Error("You already have a service listing with this title. Choose a different title or edit that listing.") as Error & { status?: number };
    conflict.status = 409;
    throw conflict;
  }
  throw error;
}

// ── Shared Marketplace Visibility Definition (Canonical Source of Truth) ──────
export const PUBLIC_PROVIDER_ACCOUNT_WHERE = {
  verificationStatus: "APPROVED" as const,
  isActive: true,
  moderationStatus: "ACTIVE" as const,
  emailVerified: true,
};

export const PUBLIC_SERVICE_PRICE_WHERE: Prisma.ServiceWhereInput = { OR: [
  { priceType: { in: RATE_PRICE_TYPES }, price: { gte: 50, lte: 50_000 } },
  { priceType: 'BY_AGREEMENT', price: null },
] };
export const PUBLIC_SERVICE_WHERE = {
  status: "ACTIVE" as const,
  isAvailable: true,
  ...PUBLIC_SERVICE_PRICE_WHERE,
  provider: PUBLIC_PROVIDER_ACCOUNT_WHERE,
};

export const PUBLIC_PROVIDER_WHERE = {
  ...PUBLIC_PROVIDER_ACCOUNT_WHERE,
  services: {
    some: {
      status: PUBLIC_SERVICE_WHERE.status,
      isAvailable: PUBLIC_SERVICE_WHERE.isAvailable,
      ...PUBLIC_SERVICE_PRICE_WHERE,
    },
  },
};

async function attachEligibleProviderRatings<T extends { providerId: string; provider: Record<string, unknown> }>(services: T[]) {
  const providerIds = [...new Set(services.map((service) => service.providerId))];
  if (!providerIds.length) return services.map(service => ({ ...service, provider: { ...service.provider, reviewsReceived: [] as Array<{ rating: number }> } }));
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

async function attachProviderWorkload<T extends { providerId: string }>(services: T[]) {
  const providerIds = [...new Set(services.map((service) => service.providerId))];
  if (!providerIds.length) return services.map(service => ({ ...service, queueLimit: 5, queueEntries: [], providerWaitingCount: 0 }));
  const [providers, entries] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: providerIds } }, select: { id: true, onlineQueueLimit: true } }),
    prisma.queue.findMany({ where: { providerId: { in: providerIds }, status: { in: ["WAITING", "SERVING"] } }, select: { providerId: true, status: true, position: true, estimatedWait: true } }),
  ]);
  const limits = new Map(providers.map((provider) => [provider.id, provider.onlineQueueLimit]));
  return services.map((service) => ({
    ...service,
    // Compatibility fields now describe the provider's one paid workload.
    queueLimit: limits.get(service.providerId) ?? 5,
    queueEntries: entries.filter((entry) => entry.providerId === service.providerId)
      .map(({ position, estimatedWait }) => ({ position, estimatedWait })),
    providerWaitingCount: entries.filter((entry) => entry.providerId === service.providerId && entry.status === "WAITING").length,
  }));
}

export async function getPublicServiceCount() {
  return prisma.service.count({
    where: PUBLIC_SERVICE_WHERE,
  });
}

export async function getActivePublicProviderCount() {
  return prisma.user.count({
    where: PUBLIC_PROVIDER_WHERE,
  });
}

export async function getRecentlyPublishedServices(limit = 6, since?: Date) {
  return prisma.service.findMany({
    where: {
      ...PUBLIC_SERVICE_WHERE,
      publishedAt: { not: null, ...(since ? { gte: since } : {}) },
    },
    orderBy: { publishedAt: "desc" },
    take: limit,
    select: {
      id: true,
      title: true,
      description: true,
      price: true,
      priceType: true,
      publishedAt: true,
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
  nearby?: NearbyQuery;
  categoryName?: string;
  ids?: string[];
}) {
  const { categoryId, search, availableOnly, excludeProviderId } = params;

  const services = await prisma.service.findMany({
    where: {
      ...PUBLIC_SERVICE_WHERE,
      ...(params.ids && { id: { in: params.ids } }),
      ...(categoryId && { categoryId }),
      ...(params.nearby && { AND: [{OR:[{serviceLocationMode:'REMOTE'},locationBounds(params.nearby)]}, ...marketplaceSearchConditions(search)] }),
      ...(params.categoryName && params.categoryName !== "All Categories" && { category: { name: { equals: canonicalCategoryName(params.categoryName), mode: "insensitive" as const } } }),
      ...(availableOnly && { isAvailable: true }),
      ...(excludeProviderId && { providerId: { not: excludeProviderId } }),
      ...(search && !params.nearby && {
        OR: [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
          { provider: { name: { contains: search, mode: "insensitive" } } },
          { category: { name: { contains: search, mode: "insensitive" } } },
        ],
      }),
    },
    include: {
      ...listingPhotosInclude,
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
  return (await attachEligibleProviderRatings(await attachProviderWorkload(services))).map(withListingPhotos);
}

// ── Get Single Service ─────────────────────────────────────────────────────────

export async function getServiceById(id: string) {
  const service = await prisma.service.findFirst({
    // This is a public endpoint. Draft, rejected, paused, and unverified
    // provider listings are available through authenticated owner/admin APIs,
    // never by guessing an ID here.
    where: { id, ...PUBLIC_SERVICE_WHERE },
    include: {
      ...listingPhotosInclude,
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

  return publicLocation(withListingPhotos((await attachProviderWorkload([service]))[0]));
}

// ── Create Listing (publish after validation; failures require revision) ─────

export async function createService(providerId: string, input: CreateServiceInput) {
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, providerId);
      await assertActiveMarketplaceAccount(tx, providerId);
      await assertListingGCashNumber(tx, providerId, input.paymentMethods);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${providerId}`}))`;
      const activeCount = await tx.service.count({
        where: { providerId, status: "ACTIVE" },
      });
      if (activeCount >= MAX_ACTIVE_LISTINGS) {
        const error = new Error(`You can have at most ${MAX_ACTIVE_LISTINGS} active service listings at a time`) as Error & { status?: number };
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

      const assessment = assessMarketplaceContent({
        kind: "SERVICE_LISTING", categoryName: category.name,
        title: input.title, description: input.description,
      });
      if (assessment.outcome === "REVISE") {
        throw Object.assign(new Error(assessment.message), { status: 422, code: "CONTENT_REVISION_REQUIRED", moderationDecision: assessment, field: assessment.field });
      }

      const service = await tx.service.create({
        data: {
          providerId,
          categoryId: category.id,
          title: input.title,
          titleNormalized: normalizeServiceTitle(input.title),
          description: input.description,
          ...(input.serviceLocation && locationData(input.serviceLocation)),
          publicMapPin: ['SEEKER_VISITS','BOTH'].includes(input.serviceLocationMode) && input.publicMapPin,
          coverageRadiusKm: null,
          transportationFee: input.priceType === 'BY_AGREEMENT' ? null : input.transportationFee,
          serviceLocationMode: input.serviceLocationMode,
          venueAddress: input.venueAddress,
          ...(input.serviceLocationMode === 'REMOTE' && { venueAddress: null, publicMapPin: false, coverageRadiusKm: null, transportationFee: null }),
          price: input.price,
          priceType: input.priceType,
          serviceType: input.serviceType,
          estimatedDurationMins: input.estimatedDurationMins,
          queueLimit: input.queueLimit,
          paymentMethods: input.paymentMethods,
          status: "ACTIVE",
          isAvailable: true,
          publishedAt: new Date(),
          moderationPolicyVersion: assessment.policyVersion,
          moderationReasonCode: assessment.reasonCode,
        },
        include: { category: true, provider: { select: { id: true, name: true, email: true } } },
      });

      await tx.contentModerationEvent.create({ data: {
        actorId: providerId, contentType: "SERVICE_LISTING", resourceId: service.id,
        outcome: assessment.outcome, reasonCode: assessment.reasonCode, policyVersion: assessment.policyVersion,
      } });

      await tx.notification.create({
        data: { userId: providerId,
          title: "Listing Published",
          body: `Your service "${input.title}" is now visible to customers.`,
          link: "/provider/service-manager?status=active" },
      });
      await setListingPhotos(tx, providerId, input.photoIds ?? [], { serviceId: service.id });
      return { service: withListingPhotos(await tx.service.findUniqueOrThrow({ where: { id: service.id }, include: { ...listingPhotosInclude, category: true, provider: { select: { id: true, name: true, email: true } } } })) };
    });
  } catch (error) {
    const rejectedDecision = (error as { moderationDecision?: ContentDecision }).moderationDecision;
    if (rejectedDecision) await prisma.contentModerationEvent.create({ data: {
      actorId: providerId, contentType: "SERVICE_LISTING", outcome: "REVISE",
      reasonCode: rejectedDecision.reasonCode, policyVersion: rejectedDecision.policyVersion,
    } });
    listingConflict(error);
  }

  safeEmit(`user:${providerId}`, "notification", { title: "Listing Published" });
  safeBroadcast("SERVICE_LISTINGS_CHANGED", { id: created.service.id, status: "ACTIVE" });
  return created.service;
}


export async function updateService(serviceId: string, providerId: string, input: UpdateServiceInput) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, providerId);
      await assertActiveMarketplaceAccount(tx, providerId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${providerId}`}))`;
      const service = await tx.service.findFirst({ where: { id: serviceId, providerId, status: { not: "DELETED" } } });
      if (!service) {
        const error = new Error("Service not found or access denied") as Error & { status?: number };
        error.status = 404;
        throw error;
      }

      let categoryId = service.categoryId;
      await assertListingGCashNumber(tx, providerId, input.paymentMethods ?? service.paymentMethods);
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
      const nextPrice = input.priceType === 'BY_AGREEMENT' ? null : input.price !== undefined ? input.price : service.price;
      if (["STARTS_AT", "CUSTOM"].includes(service.priceType) && (input.priceType === undefined || input.price === undefined)) {
        const error = new Error("Choose a supported pricing type and update the price for this older listing") as Error & { status?: number };
        error.status = 400;
        throw error;
      }
      if (!validListingPrice(nextPriceType, nextPrice)) {
        const error = new Error("Enter a valid service price, or choose Price by agreement and leave the price blank") as Error & { status?: number };
        error.status = 400;
        throw error;
      }

      const materialChanged = normalizeServiceTitle(nextTitle) !== service.titleNormalized
        || categoryId !== service.categoryId
        || (input.description !== undefined && input.description !== service.description)
        || ["REJECTED", "PENDING_REVIEW"].includes(service.status);

      const assessment = materialChanged ? assessMarketplaceContent({
        kind: "SERVICE_LISTING",
        categoryName: (await tx.category.findUniqueOrThrow({ where: { id: categoryId }, select: { name: true } })).name,
        title: nextTitle, description: input.description ?? service.description,
      }) : null;
      if (assessment?.outcome === "REVISE") {
        throw Object.assign(new Error(assessment.message), { status: 422, code: "CONTENT_REVISION_REQUIRED", moderationDecision: assessment, field: assessment.field });
      }

      if (materialChanged && service.status !== "ACTIVE" && service.status !== "INACTIVE") {
        const occupied = await tx.service.count({ where: { providerId, status: "ACTIVE" } });
        if (occupied >= MAX_ACTIVE_LISTINGS) {
          throw Object.assign(new Error("Pause or archive a listing before publishing another"), { status: 422 });
        }
      }

      const { serviceLocation, photoIds, ...updatedInput } = input;
      if (photoIds !== undefined) await setListingPhotos(tx, providerId, photoIds, { serviceId });
      assertLocationForArrangementChange(service.serviceLocationMode, input.serviceLocationMode, serviceLocation, 'PROVIDER_VISITS');
      if (['SEEKER_VISITS', 'BOTH'].includes(input.serviceLocationMode ?? service.serviceLocationMode) && input.venueAddress !== undefined && (input.venueAddress?.trim().length ?? 0) < 5) throw Object.assign(new Error('Enter your workplace address for seekers who visit you.'), { status:400 });
      if (serviceLocation === null && (input.serviceLocationMode ?? service.serviceLocationMode) !== 'REMOTE') throw Object.assign(new Error('In-person services need a base area or shop location.'), {status:400});
      if (['SEEKER_VISITS', 'BOTH'].includes(input.serviceLocationMode ?? service.serviceLocationMode) && !serviceLocation && (service.latitude == null || service.longitude == null || !service.locationLabel)) {
        throw Object.assign(new Error('Choose your service venue before accepting seeker visits.'), { status: 400 });
      }
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: {
          ...updatedInput,
          coverageRadiusKm: null,
          ...(serviceLocation && locationData(serviceLocation)),
          ...((serviceLocation === null || (input.serviceLocationMode === 'REMOTE' && service.serviceLocationMode !== 'REMOTE' && !serviceLocation)) && {latitude:null,longitude:null,locationLabel:null}),
          ...((input.serviceLocationMode ?? service.serviceLocationMode) === 'PROVIDER_VISITS' && {publicMapPin:false}),
          ...(serviceLocation && input.publicMapPin === undefined &&
            (serviceLocation.latitude !== service.latitude || serviceLocation.longitude !== service.longitude)
            ? { publicMapPin: false } : {}),
          title: nextTitle,
          titleNormalized: normalizeServiceTitle(nextTitle),
          categoryId,
          price: nextPrice,
          transportationFee: nextPriceType === 'BY_AGREEMENT' ? null : input.transportationFee !== undefined ? input.transportationFee : service.transportationFee,
          ...((input.serviceLocationMode ?? service.serviceLocationMode) === 'REMOTE' && { venueAddress: null, publicMapPin: false, coverageRadiusKm: null, transportationFee: null }),
          ...(materialChanged && assessment && {
            status: service.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
            isAvailable: service.status !== "INACTIVE",
            publishedAt: service.status === "INACTIVE" ? service.publishedAt : service.publishedAt ?? new Date(),
            moderationPolicyVersion: assessment.policyVersion,
            moderationReasonCode: assessment.reasonCode,
            reviewedById: null, reviewedAt: null,
          }),
        },
        include: { ...listingPhotosInclude, category: true },
      });

      if (!materialChanged) return { service: updated };

      await tx.contentModerationEvent.create({ data: {
        actorId: providerId, contentType: "SERVICE_LISTING", resourceId: serviceId,
        outcome: assessment!.outcome, reasonCode: assessment!.reasonCode, policyVersion: assessment!.policyVersion,
      } });

      return { service: updated };
    });

    safeBroadcast("SERVICE_LISTINGS_CHANGED", { id: serviceId, status: result.service.status });
    return withListingPhotos(result.service);
  } catch (error) {
    const rejectedDecision = (error as { moderationDecision?: ContentDecision }).moderationDecision;
    if (rejectedDecision) await prisma.contentModerationEvent.create({ data: {
      actorId: providerId, contentType: "SERVICE_LISTING", resourceId: serviceId,
      outcome: "REVISE", reasonCode: rejectedDecision.reasonCode, policyVersion: rejectedDecision.policyVersion,
    } });
    listingConflict(error);
  }
}


export async function toggleServiceAvailability(serviceId: string, providerId: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockAccountLifecycle(tx, providerId);
      await assertActiveMarketplaceAccount(tx, providerId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-listings:${providerId}`}))`;
      const service = await tx.service.findFirst({ where: { id: serviceId, providerId, status: { in: ['ACTIVE', 'INACTIVE'] } } });
      if (!service) throw Object.assign(new Error('Only an active or paused listing can be paused or resumed'), { status: 404 });
      const resume = service.status === 'INACTIVE' || !service.isAvailable;
      if (resume) {
        const occupied = await tx.service.count({ where: { providerId, id: { not: serviceId }, status: 'ACTIVE' } });
        if (occupied >= MAX_ACTIVE_LISTINGS) throw Object.assign(new Error('Pause or archive another listing before resuming this one'), { status: 422 });
      }
      return tx.service.update({ where: { id: serviceId }, data: { status: resume ? 'ACTIVE' : 'INACTIVE', isAvailable: resume, ...(resume && { publishedAt: service.publishedAt ?? new Date() }) } });
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

  const result = await prisma.$transaction(async tx => {
    await tx.queueNotify.deleteMany({ where: { serviceId } });
    const inquiries = await tx.serviceRequest.findMany({ where: { targetServiceId: serviceId, status: 'OPEN' }, select: { id: true, seekerId: true } });
    if (inquiries.length) await tx.notification.createMany({ data: inquiries.map(inquiry => ({
      id: `listing-removed:${serviceId}:${inquiry.id}`, userId: inquiry.seekerId, title: 'Requested service listing removed',
      body: `The provider removed "${service.title}". Check your request and choose another service.`,
      link: `/seeker/request-manager?requestId=${inquiry.id}`,
    })), skipDuplicates: true });
    const removed = await tx.service.update({ where: { id: serviceId }, data: { status: 'DELETED', isAvailable: false } });
    return { removed, seekerIds: inquiries.map(inquiry => inquiry.seekerId) };
  });
  for (const seekerId of new Set(result.seekerIds)) safeEmit(`user:${seekerId}`, 'notification', { title: 'Requested service listing removed' });
  return result.removed;
}

// ── Get My Listings (Provider) ─────────────────────────────────────────────────

export async function getMyServices(providerId: string) {
  const services = await prisma.service.findMany({
    where: { providerId, status: { not: "DELETED" } },
    include: {
      ...listingPhotosInclude,
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
  return (await attachEligibleProviderRatings(await attachProviderWorkload(services))).map(withListingPhotos);
}

export async function listAdminServices(page = 1, limit = 20, status?: ServiceStatus | "LIVE") {
  const where: Prisma.ServiceWhereInput = status === "LIVE"
    ? PUBLIC_SERVICE_WHERE
    : status
    ? { status }
    : { status: { not: "DELETED" } };
  const [items, total] = await Promise.all([
    prisma.service.findMany({
      where,
      include: {
        provider: {
          select: { id: true, name: true, email: true, trustScore: true, verificationStatus: true },
        },
        category: true,
      },
      orderBy: { updatedAt: "desc" },
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

