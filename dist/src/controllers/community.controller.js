import { prisma } from "../lib/prisma";
import { getPublicServiceCount, getActivePublicProviderCount, getRecentlyPublishedServices, } from "../services/services.service";
/**
 * GET /community/stats
 *
 * Serves all live public marketplace & community data for the Community Hub:
 *   - Top Providers leaderboard (publicly discoverable providers with active services, ranked deterministically)
 *   - Platform-wide community stats (Services Completed, Verified Residents, Active Providers, Active Listings)
 *   - Recently published public services (active, approved listings ordered by approval timestamp)
 *   - Newly approved categories (approved suggestions verified against active marketplace categories)
 */
export async function getCommunityStats(req, res, next) {
    try {
        const [topProvidersRaw, totalCompleted, verifiedUsers, activeProviders, activeListings, recentServices, activeCategories, approvedSuggestions,] = await Promise.all([
            // ── 1. Top Providers Leaderboard ───────────────────────────────────────
            // Must be active, residency-approved, have >= 1 completed service,
            // and have active public services in the marketplace.
            prisma.user.findMany({
                where: {
                    verificationStatus: "APPROVED",
                    isActive: true,
                    completedAsProvider: { some: {} },
                    services: {
                        some: {
                            status: "ACTIVE",
                            isAvailable: true,
                        },
                    },
                },
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
                    verificationStatus: true,
                    services: {
                        where: { status: "ACTIVE", isAvailable: true },
                        select: { title: true, category: { select: { name: true } } },
                        take: 2,
                    },
                    _count: {
                        select: { completedAsProvider: true },
                    },
                    completedAsProvider: {
                        select: {
                            reviews: {
                                select: { rating: true },
                            },
                        },
                    },
                },
                orderBy: [
                    { trustScore: "desc" },
                    { completedAsProvider: { _count: "desc" } },
                ],
                take: 8,
            }),
            // ── 2. Services Completed (Real DB Count) ──────────────────────────────
            prisma.completedService.count(),
            // ── 3. Verified Residents (Real DB Count) ──────────────────────────────
            prisma.user.count({ where: { verificationStatus: "APPROVED", isActive: true } }),
            // ── 4. Active Discoverable Providers (Marketplace Aligned) ────────────
            getActivePublicProviderCount(),
            // ── 5. Active Service Listings (Canonical Marketplace Query) ───────────
            getPublicServiceCount(),
            // ── 6. Recently Published Services (Approved Public Listings) ──────────
            getRecentlyPublishedServices(6),
            // ── 7. Active Categories in Marketplace ────────────────────────────────
            prisma.category.findMany({
                where: { isActive: true },
                select: { name: true },
            }),
            // ── 8. Recently Approved Category Suggestions ──────────────────────────
            prisma.categorySuggested.findMany({
                where: { status: "APPROVED" },
                orderBy: { reviewedAt: "desc" },
                take: 6,
                select: { id: true, name: true, description: true, reviewedAt: true },
            }),
        ]);
        // Ensure approved suggestions are actually active categories
        const activeCategoryNames = new Set(activeCategories.map((c) => c.name.toLowerCase()));
        const recentCategories = approvedSuggestions.filter((s) => activeCategoryNames.has(s.name.toLowerCase()));
        // Process top providers & aggregate ratings
        const leaderboard = topProvidersRaw.map((p, idx) => {
            const allRatings = p.completedAsProvider.flatMap((cs) => cs.reviews.map((r) => r.rating));
            const avgRating = allRatings.length > 0
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
                completedJobs: p._count.completedAsProvider,
                avgRating: avgRating ? parseFloat(avgRating.toFixed(1)) : null,
                reviewCount: allRatings.length,
                primaryService: primaryCategory,
            };
        });
        // Deterministic sort: Trust Score DESC → Completed Jobs DESC → Avg Rating DESC
        leaderboard.sort((a, b) => {
            if (b.trustScore !== a.trustScore)
                return b.trustScore - a.trustScore;
            if (b.completedJobs !== a.completedJobs)
                return b.completedJobs - a.completedJobs;
            return (b.avgRating ?? 0) - (a.avgRating ?? 0);
        });
        leaderboard.forEach((p, i) => {
            p.rank = i + 1;
        });
        res.json({
            success: true,
            data: {
                leaderboard,
                stats: {
                    totalCompleted,
                    verifiedUsers,
                    activeProviders,
                    activeListings,
                },
                recentCategories,
                recentServices,
            },
        });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=community.controller.js.map