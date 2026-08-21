import { prisma } from "../lib/prisma";
/**
 * GET /community/stats
 *
 * Serves all live data for the Community Hub (Part 19):
 *   - Top Providers leaderboard (ranked by trust score + completed services + rating)
 *   - Platform-wide community stats (completedServices, verifiedUsers, activeProviders, activeSeekers)
 *   - Admin announcements (Notification records marked as system-wide)
 *   - Newly added categories (last 10 approved category suggestions)
 */
export async function getCommunityStats(req, res, next) {
    try {
        const [topProviders, totalCompleted, verifiedUsers, activeProviders, recentCategories,] = await Promise.all([
            // ── Top Providers Leaderboard ──────────────────────────────────────────
            // Ranked by: trust score (primary) → completed services count (secondary) → avg rating (tiebreaker)
            // Only verified, active providers with at least one completed service are listed.
            prisma.user.findMany({
                where: {
                    verificationStatus: "APPROVED",
                    isActive: true,
                    completedAsProvider: { some: {} }, // must have at least 1 completed service
                },
                select: {
                    id: true,
                    name: true,
                    avatarUrl: true,
                    trustScore: true,
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
                take: 10,
            }),
            // ── Community Stats ────────────────────────────────────────────────────
            prisma.completedService.count(),
            prisma.user.count({ where: { verificationStatus: "APPROVED", isActive: true } }),
            prisma.service.count({ where: { status: "ACTIVE", isAvailable: true } }),
            // ── Recently Approved Category Suggestions (Part 18/19) ───────────────
            // These auto-post when admin approves a suggestion — newest 8
            prisma.categorySuggested.findMany({
                where: { status: "APPROVED" },
                orderBy: { reviewedAt: "desc" },
                take: 8,
                select: { id: true, name: true, description: true, reviewedAt: true },
            }),
        ]);
        // Post-process top providers — calculate average rating per provider
        const leaderboard = topProviders.map((p, idx) => {
            const allRatings = p.completedAsProvider.flatMap((cs) => cs.reviews.map((r) => r.rating));
            const avgRating = allRatings.length > 0
                ? allRatings.reduce((sum, r) => sum + r, 0) / allRatings.length
                : null;
            return {
                rank: idx + 1,
                id: p.id,
                name: p.name,
                avatarUrl: p.avatarUrl || null,
                trustScore: p.trustScore,
                completedJobs: p._count.completedAsProvider,
                avgRating: avgRating ? parseFloat(avgRating.toFixed(1)) : null,
                reviewCount: allRatings.length,
            };
        });
        // Sort by trust score first, then by completed jobs — the DB already does primary sort
        // but we re-sort after the rating aggregation to be precise
        leaderboard.sort((a, b) => {
            if (b.trustScore !== a.trustScore)
                return b.trustScore - a.trustScore;
            if (b.completedJobs !== a.completedJobs)
                return b.completedJobs - a.completedJobs;
            return (b.avgRating ?? 0) - (a.avgRating ?? 0);
        });
        // Re-assign ranks after final sort
        leaderboard.forEach((p, i) => { p.rank = i + 1; });
        res.json({
            success: true,
            data: {
                leaderboard,
                stats: {
                    totalCompleted,
                    verifiedUsers,
                    activeListings: activeProviders,
                },
                recentCategories,
            },
        });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=community.controller.js.map