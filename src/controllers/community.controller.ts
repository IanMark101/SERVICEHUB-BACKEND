import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import {
  getPublicServiceCount,
  getActivePublicProviderCount,
  getRecentlyPublishedServices,
  PUBLIC_PROVIDER_WHERE,
  PUBLIC_SERVICE_WHERE,
} from "../services/services.service";

const RECENT_CONTENT_WINDOW_DAYS = 30;

/**
 * GET /community/stats
 *
 * Serves all live public marketplace & community data for the Community Hub:
 *   - Top Providers leaderboard (publicly discoverable providers with active services, ranked deterministically)
 *   - Platform-wide community stats (Services Completed, Verified Residents, Active Providers, Active Listings)
 *   - Recently added active categories created by administrators
 *   - Recently published public service listings
 *   - Official administration announcements
 */
export async function getCommunityStats(_req: Request, res: Response, next: NextFunction) {
  try {
    // Use Philippine time explicitly so deployment-host timezone does
    // not move the weekly boundary. The Philippines is UTC+8 with no DST.
    const philippineOffsetMs = 8 * 60 * 60 * 1000;
    const philippineNow = new Date(Date.now() + philippineOffsetMs);
    philippineNow.setUTCHours(0, 0, 0, 0);
    philippineNow.setUTCDate(philippineNow.getUTCDate() - ((philippineNow.getUTCDay() + 6) % 7));
    const leaderboardWeekStart = new Date(philippineNow.getTime() - philippineOffsetMs);
    const leaderboardWeekEnd = new Date(leaderboardWeekStart);
    leaderboardWeekEnd.setDate(leaderboardWeekEnd.getDate() + 7);

    const [
      topProvidersRaw,
      totalCompleted,
      verifiedUsers,
      activeProviders,
      activeListings,
      activeCategories,
      categoryCreationEvents,
      recentlyPublishedServices,
      announcements,
    ] = await Promise.all([
      // ── 1. Top Providers Leaderboard ───────────────────────────────────────
      // Must be active, residency-approved, have >= 1 completed service,
      // and have active public services in the marketplace.
      prisma.user.findMany({
        where: {
          ...PUBLIC_PROVIDER_WHERE,
          completedAsProvider: {
            some: { completedAt: { gte: leaderboardWeekStart, lt: leaderboardWeekEnd } },
          },
        },
        select: {
          id: true,
          name: true,
          avatarUrl: true,
          trustScore: true,
          verificationStatus: true,
          services: {
            where: PUBLIC_SERVICE_WHERE,
            select: { title: true, category: { select: { name: true } } },
            take: 2,
          },
          completedAsProvider: {
            where: { completedAt: { gte: leaderboardWeekStart, lt: leaderboardWeekEnd } },
            select: {
              reviews: {
                where: { visibility: "VISIBLE" },
                select: { rating: true, targetId: true },
              },
            },
          },
        },
        orderBy: { trustScore: "desc" },
      }),

      // ── 2. Services Completed (Real DB Count) ──────────────────────────────
      prisma.completedService.count(),

      // ── 3. Verified Residents (Real DB Count) ──────────────────────────────
      prisma.user.count({ where: { verificationStatus: "APPROVED", isActive: true, moderationStatus: "ACTIVE", emailVerified: true } }),

      // ── 4. Active Discoverable Providers (Marketplace Aligned) ────────────
      getActivePublicProviderCount(),

      // ── 5. Active Service Listings (Canonical Marketplace Query) ───────────
      getPublicServiceCount(),

      // ── 6. Active Categories in Marketplace ────────────────────────────────
      prisma.category.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      }),

      // Recent category additions use the recorded Admin creation time.
      prisma.adminAuditLog.findMany({
        where: {
          action: "CATEGORY_CREATED", resourceType: "Category",
          createdAt: { gte: new Date(Date.now() - RECENT_CONTENT_WINDOW_DAYS * 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        select: { resourceId: true, createdAt: true },
      }),

      getRecentlyPublishedServices(
        6,
        new Date(Date.now() - RECENT_CONTENT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      ),

      // ── 9. Official Community Hub Announcements ────────────────────────────
      prisma.announcement.findMany({
        where: {
          isPublished: true,
          publishedAt: { not: null, lte: new Date() },
        },
        select: {
          id: true,
          title: true,
          body: true,
          publishedAt: true,
          author: { select: { name: true } },
        },
        orderBy: { publishedAt: "desc" },
        take: 3,
      }),
    ]);

    const categoryById = new Map(activeCategories.map(category => [category.id, category]));
    const recentCategories = categoryCreationEvents.flatMap(event => {
      const category = event.resourceId ? categoryById.get(event.resourceId) : undefined;
      return category ? [{ ...category, addedAt: event.createdAt }] : [];
    }).slice(0, 6);

    // Process top providers & aggregate ratings
    const leaderboard = topProvidersRaw.map((p, idx) => {
      const allRatings = p.completedAsProvider.flatMap((cs) =>
        cs.reviews.filter((review) => review.targetId === p.id).map((review) => review.rating)
      );
      const avgRating =
        allRatings.length > 0
          ? allRatings.reduce((sum, r) => sum + r, 0) / allRatings.length
          : null;

      const primaryCategory = p.services[0]?.category?.name || p.services[0]?.title || null;

      return {
        rank: idx + 1,
        id: p.id,
        name: p.name,
        avatarUrl: p.avatarUrl || null,
        trustScore: p.trustScore,
        verificationStatus: p.verificationStatus,
        completedJobs: p.completedAsProvider.length,
        avgRating: avgRating ? parseFloat(avgRating.toFixed(1)) : null,
        reviewCount: allRatings.length,
        primaryService: primaryCategory,
      };
    });

    // Deterministic sort: Trust Score DESC → Completed Jobs DESC → Avg Rating DESC
    leaderboard.sort((a, b) => {
      if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
      if (b.completedJobs !== a.completedJobs) return b.completedJobs - a.completedJobs;
      return (b.avgRating ?? 0) - (a.avgRating ?? 0);
    });

    const weeklyLeaders = leaderboard.slice(0, 8);
    weeklyLeaders.forEach((p, i) => {
      p.rank = i + 1;
    });

    res.json({
      success: true,
      data: {
        leaderboard: weeklyLeaders,
        stats: {
          totalCompleted,
          verifiedUsers,
          activeProviders,
          activeListings,
        },
        recentCategories,
        recentServices: recentlyPublishedServices.map((service) => ({
          ...service,
          priceType: service.priceType === "PER_SESSION" ? "FIXED" : service.priceType,
        })),
        announcements,
        leaderboardPeriod: {
          start: leaderboardWeekStart.toISOString(),
          end: leaderboardWeekEnd.toISOString(),
        },
      },
    });
  } catch (err) {
    next(err);
  }
}
