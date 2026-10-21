import { prisma } from '../lib/prisma';
import { PUBLIC_SERVICE_WHERE } from './services.service';
import { subscriptionBenefits, subscriptionSelect, type SubscriptionState } from './subscription-policy';

export interface FeaturedCandidate {
  id: string; providerId: string; publishedAt: Date | null;
  provider: SubscriptionState & { trustScore: number };
  reviews: { targetId: string; rating: number }[];
}

/** Featured selection only. Ordinary search and the community leaderboard are untouched.
 * Trust (0–100) and rating (0–100) dominate a small five-point Pro tie advantage.
 * Quality thresholds apply before any subscription boost, with one result per provider.
 */
export function selectFeaturedServices<T extends FeaturedCandidate>(services: T[], limit = 6, now = new Date()) {
  const scored = services.flatMap(service => {
    const ratings = service.reviews.filter(review => review.targetId === service.providerId);
    if (service.provider.trustScore < 50 || ratings.length === 0) return [];
    const average = ratings.reduce((sum, review) => sum + review.rating, 0) / ratings.length;
    if (average < 4) return [];
    const quality = service.provider.trustScore * 0.6 + average * 20 * 0.4;
    return [{ service, score: quality + (subscriptionBenefits(service.provider, now).featuredPriority ? 5 : 0) }];
  }).sort((a, b) => b.score - a.score || (b.service.publishedAt?.getTime() ?? 0) - (a.service.publishedAt?.getTime() ?? 0) || a.service.id.localeCompare(b.service.id));
  const providers = new Set<string>();
  return scored.filter(({ service }) => { if (providers.has(service.providerId)) return false; providers.add(service.providerId); return true; }).slice(0, limit).map(({ service }) => service);
}

export async function getFeaturedServices() {
  // Candidate quality is selected in SQL before the bounded final ranking.
  // The five-point boost cannot exclude higher-quality Free candidates at the cutoff.
  const candidates = await prisma.service.findMany({ where: { ...PUBLIC_SERVICE_WHERE,
    provider: { ...PUBLIC_SERVICE_WHERE.provider, trustScore: { gte: 50 } },
    publishedAt: { not: null },
  }, orderBy: [{ provider: { trustScore: 'desc' } }, { publishedAt: 'desc' }], take: 120,
    select: { id: true, providerId: true, title: true, description: true, price: true, priceType: true, publishedAt: true,
      category: { select: { id: true, name: true } },
      provider: { select: { ...subscriptionSelect, id: true, name: true, avatarUrl: true, trustScore: true, verificationStatus: true } } } });
  const reviews = await prisma.review.findMany({ where: { visibility: 'VISIBLE', targetId: { in: [...new Set(candidates.map(service => service.providerId))] } },
    select: { targetId: true, rating: true, completedService: { select: { providerId: true } } } });
  const selected = selectFeaturedServices(candidates.map(service => ({ ...service,
    reviews: reviews.filter(review => review.targetId === service.providerId && review.completedService.providerId === service.providerId) })));
  return selected.map(({ reviews: _reviews, providerId: _providerId, provider, ...service }) => ({ ...service,
    provider: { id: provider.id, name: provider.name, avatarUrl: provider.avatarUrl, trustScore: provider.trustScore, verificationStatus: provider.verificationStatus } }));
}
