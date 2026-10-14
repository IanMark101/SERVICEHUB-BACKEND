import type { NearbyQuery } from '../schema/location.schema';
import { browseServices } from './services.service';
import { listRequests } from './requests.service';
import { inRadius, nearbyPage, publicLocation, publicMapArea } from '../lib/proximity';

export async function nearbyServices(query: NearbyQuery) {
  const candidates = await browseServices({ nearby: query, search: query.search, categoryName: query.category });
  const matches = candidates.flatMap(service => {
    const distance = inRadius(service, query);
    if (distance === null) return []; // Search center is not an agreed job location.
    const waiting = service.providerWaitingCount;
    if (query.filter === 'available' && waiting >= service.queueLimit) return [];
    if (query.filter === 'low-queue' && waiting > 2) return [];
    const reviews = service.provider.reviewsReceived;
    const rating = reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : 0;
    if (query.filter === 'rated' && rating < 4) return [];
    return [{ ...publicLocation(service), distanceKm: Math.round(distance * 10) / 10, _distance: distance, _mapArea: publicMapArea(service, service.publicMapPin) }];
  }).sort((a, b) => a._distance - b._distance || Number(b.provider.trustScore) - Number(a.provider.trustScore));
  return {
    ...nearbyPage(matches.map(({ _distance, _mapArea, ...item }) => item), query),
    mapPins: matches.map(item => ({ id:item.id, title:item.title, ...(item.provider.name ? { providerName:item.provider.name } : {}), label:item.locationLabel || 'Service area', area:item._mapArea })),
  };
}

export async function nearbyRequests(query: NearbyQuery, providerId: string) {
  const candidates = await listRequests(undefined, providerId, query);
  const matches = candidates.filter(request => !request.targetServiceId).flatMap(request => {
    const distance = inRadius(request, query);
    if (distance === null) return [];
    if (query.filter === 'high-budget' && Number(request.budgetMax) < 500) return [];
    if (query.filter === 'few-offers' && request.offersCount > 1) return [];
    if (query.filter === 'urgent' && !['ASAP / Today', 'Needs Tomorrow'].includes(request.urgency)) return [];
    return [{ ...publicLocation(request), distanceKm: Math.round(distance * 10) / 10, _distance: distance, _mapArea: publicMapArea(request) }];
  }).sort((a, b) => {
    if (query.filter === 'high-budget') return Number(b.budgetMax) - Number(a.budgetMax) || a._distance - b._distance;
    if (query.filter === 'few-offers') return a.offersCount - b.offersCount || a._distance - b._distance;
    return a._distance - b._distance || b.createdAt.getTime() - a.createdAt.getTime();
  });
  return {
    ...nearbyPage(matches.map(({ _distance, _mapArea, ...item }) => item), query),
    mapPins: matches.map(item => ({ id:item.id, title:item.title, label:item.locationLabel || 'Job area', area:item._mapArea })),
  };
}
