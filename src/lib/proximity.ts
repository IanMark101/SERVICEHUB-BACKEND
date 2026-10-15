import { JobLocationSchema, type JobLocation, type LocationPoint, type NearbyQuery } from '../schema/location.schema';

const EARTH_KM = 6371.0088;
export function distanceKm(a: Pick<LocationPoint, 'latitude' | 'longitude'>, b: Pick<LocationPoint, 'latitude' | 'longitude'>) {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function locationData(point: LocationPoint) {
  return { latitude: point.latitude, longitude: point.longitude, locationLabel: point.label };
}
export function locationFromRecord(record: { latitude?: number | null; longitude?: number | null; locationLabel?: string | null; privateAddress?: string | null }): JobLocation | undefined {
  if (record.latitude == null || record.longitude == null || !record.locationLabel) return undefined;
  return { latitude: record.latitude, longitude: record.longitude, label: record.locationLabel,
    ...(record.privateAddress ? { address: record.privateAddress } : {}) };
}

/** Never return precise marketplace coordinates or private addresses to browsers/broadcasts. */
export function publicLocation<T extends Record<string, unknown>>(record: T) {
  const { latitude: _latitude, longitude: _longitude, privateAddress: _address, venueAddress: _venueAddress, ...publicRecord } = record;
  return publicRecord;
}

/** Fixed public grid, independent of the search center. Never expose a home's exact pin. */
export function publicMapArea(record: { latitude?: number | null; longitude?: number | null }, publicMapPin = false) {
  if (record.latitude == null || record.longitude == null) return null;
  if (publicMapPin) return { latitude: record.latitude, longitude: record.longitude, approximate: false as const };
  return { latitude: Math.round(record.latitude * 100) / 100, longitude: Math.round(record.longitude * 100) / 100, approximate: true as const };
}

export function locationBounds(query: Pick<NearbyQuery, 'latitude' | 'longitude' | 'radiusKm'>) {
  const latDelta = query.radiusKm / EARTH_KM * 180 / Math.PI;
  const angular = query.radiusKm / EARTH_KM;
  const reachesPole = Math.abs(query.latitude) + latDelta >= 90;
  const ratio = Math.sin(angular) / Math.cos(query.latitude * Math.PI / 180);
  const lngDelta = reachesPole ? 180 : Math.asin(Math.min(1, Math.abs(ratio))) * 180 / Math.PI;
  const low = query.longitude - lngDelta;
  const high = query.longitude + lngDelta;
  const longitude = reachesPole ? { longitude: { gte: -180, lte: 180 } } : low < -180 ? { OR: [{ longitude: { gte: low + 360 } }, { longitude: { lte: high } }] }
    : high > 180 ? { OR: [{ longitude: { gte: low } }, { longitude: { lte: high - 360 } }] }
    : { longitude: { gte: low, lte: high } };
  return { latitude: { gte: Math.max(-90, query.latitude - latDelta), lte: Math.min(90, query.latitude + latDelta) }, ...longitude };
}

export function inRadius(record: { latitude?: number | null; longitude?: number | null }, query: Pick<NearbyQuery, 'latitude' | 'longitude' | 'radiusKm'>) {
  if (record.latitude == null || record.longitude == null) return null;
  const distance = distanceKm(query, { latitude: record.latitude, longitude: record.longitude });
  return distance <= query.radiusKm + 0.000001 ? distance : null;
}
export function assertJobLocation(job: JobLocation | undefined) {
  if (!job) throw Object.assign(new Error('Choose the actual job location before booking this service.'), { status: 400, code: 'JOB_LOCATION_REQUIRED' });
  JobLocationSchema.parse(job);
}

export function nearbyPage<T>(items: T[], query: NearbyQuery) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.min(query.page, totalPages);
  return { items: items.slice((page - 1) * query.limit, page * query.limit),
    pagination: { page, limit: query.limit, total, totalPages } };
}
