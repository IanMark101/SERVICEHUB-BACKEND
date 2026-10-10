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
  const { latitude: _latitude, longitude: _longitude, privateAddress: _address, ...publicRecord } = record;
  return publicRecord;
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
export function assertServiceCoverage(service: { latitude?: number | null; longitude?: number | null; coverageRadiusKm?: number | null }, job: JobLocation | undefined) {
  if (service.latitude == null || service.longitude == null) return; // Historical listings remain usable.
  if (!job) throw Object.assign(new Error('Choose the actual job location before booking this service.'), { status: 400, code: 'JOB_LOCATION_REQUIRED' });
  JobLocationSchema.parse(job);
  if (service.coverageRadiusKm != null && distanceKm({ latitude: service.latitude, longitude: service.longitude }, job) > service.coverageRadiusKm + 0.000001) {
    throw Object.assign(new Error('The job location is outside this listing’s service coverage. Choose another provider or job location.'), { status: 409, code: 'OUTSIDE_SERVICE_COVERAGE' });
  }
}

export function nearbyPage<T>(items: T[], query: NearbyQuery) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.min(query.page, totalPages);
  return { items: items.slice((page - 1) * query.limit, page * query.limit),
    pagination: { page, limit: query.limit, total, totalPages } };
}
