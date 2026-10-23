import { prisma } from '../lib/prisma';
import { publicServiceWhere } from './services.service';
import { subscriptionBenefits, subscriptionSelect, type SubscriptionState } from './subscription-policy';

export interface FeaturedCandidate {
  id: string; providerId: string; publishedAt: Date | null;
  provider: SubscriptionState & { trustScore: number };
  reviews: { targetId: string; rating: number }[];
}

/** Featured placement is a Pro benefit. Ordinary search and Trust Score are
 * unchanged. Quality thresholds still apply, with one result per provider.
 */
export function selectFeaturedServices<T extends FeaturedCandidate>(services: T[], limit = 6, now = new Date()) {
  const scored = services.flatMap(service => {
    if (!subscriptionBenefits(service.provider, now).featuredPriority) return [];
    const ratings = service.reviews.filter(review => review.targetId === service.providerId);
    if (service.provider.trustScore < 50 || ratings.length === 0) return [];
    const average = ratings.reduce((sum, review) => sum + review.rating, 0) / ratings.length;
    if (average < 4) return [];
    const quality = service.provider.trustScore * 0.6 + average * 20 * 0.4;
    return [{ service, score: quality }];
  }).sort((a, b) => b.score - a.score || (b.service.publishedAt?.getTime() ?? 0) - (a.service.publishedAt?.getTime() ?? 0) || a.service.id.localeCompare(b.service.id));
  const providers = new Set<string>();
  return scored.filter(({ service }) => { if (providers.has(service.providerId)) return false; providers.add(service.providerId); return true; }).slice(0, limit).map(({ service }) => service);
}

export async function getFeaturedServices() {
  // Candidate quality is selected in SQL before the bounded final ranking.
  // Membership and quality are checked again before ranking eligible candidates.
  const candidates = await prisma.service.findMany({ where: { ...publicServiceWhere(),
    provider: { ...publicServiceWhere().provider, subscriptionPlan: 'PRO', trustScore: { gte: 50 } },
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
