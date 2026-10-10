import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { distanceKm, inRadius, locationBounds, publicLocation, nearbyPage, assertServiceCoverage } from '../lib/proximity';
import { LocationPointSchema, NearbyQuerySchema, TransportationFeeSchema } from './location.schema';
import { calculateDirectListingTerms } from '../services/bookings/direct-listing-pricing';

const center = { latitude: 10.3, longitude: 123.9, label: 'Cordova, Cebu' };

test('coordinates, radii, page limits and transportation amounts are bounded', () => {
  assert.equal(LocationPointSchema.safeParse({ ...center, latitude: 91 }).success, false);
  assert.equal(LocationPointSchema.safeParse({ ...center, longitude: NaN }).success, false);
  assert.equal(LocationPointSchema.safeParse({ ...center, label: ' ' }).success, false);
  for (const radiusKm of [0, 31, 'bad']) assert.equal(NearbyQuerySchema.safeParse({ latitude: 10, longitude: 123, radiusKm }).success, false);
  assert.equal(NearbyQuerySchema.safeParse({ latitude: 10, longitude: 123, radiusKm: 5, limit: 100 }).success, false);
  for (const amount of [-1, 5001, 1.001, Infinity]) assert.equal(TransportationFeeSchema.safeParse(amount).success, false);
  assert.equal(TransportationFeeSchema.safeParse(0).success, true);
  assert.equal(TransportationFeeSchema.safeParse(125.25).success, true);
});

test('radius uses exact distance across municipality names and excludes unknown positions', () => {
  const nearby = { latitude: 10.31, longitude: 123.9, label: 'Lapu-Lapu City' };
  assert.ok(distanceKm(center, nearby) > 1 && distanceKm(center, nearby) < 2);
  assert.notEqual(inRadius(nearby, { ...center, radiusKm: 2 }), null);
  assert.equal(inRadius(nearby, { ...center, radiusKm: 1 }), null);
  assert.equal(inRadius({ latitude: null, longitude: null }, { ...center, radiusKm: 30 }), null);
  assert.equal(inRadius(center, { ...center, radiusKm: 1 }), 0);
  const distance = distanceKm(center, nearby);
  assert.notEqual(inRadius(nearby, { ...center, radiusKm: distance }), null);
  assert.equal(inRadius(nearby, { ...center, radiusKm: distance - .001 }), null);
});

test('bounding queries do not lose boundary candidates, including poles and date line', () => {
  const earth = 6371.0088;
  for (const latitude of [0, 10.3, 70, 89.99]) {
    const query = { latitude, longitude: 123, radiusKm: 30 };
    const angular = query.radiusKm / earth;
    for (let bearing = 0; bearing < 360; bearing += 10) {
      const lat = latitude * Math.PI / 180, angle = bearing * Math.PI / 180;
      const destLat = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(angle));
      const rawLng = query.longitude + Math.atan2(Math.sin(angle) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(destLat)) * 180 / Math.PI;
      const destLng = ((rawLng + 540) % 360) - 180;
      const bounds = locationBounds(query);
      assert.ok(destLat * 180 / Math.PI >= bounds.latitude.gte - 1e-8 && destLat * 180 / Math.PI <= bounds.latitude.lte + 1e-8);
      if ('longitude' in bounds && bounds.longitude) assert.ok(destLng >= bounds.longitude.gte - 1e-8 && destLng <= bounds.longitude.lte + 1e-8);
    }
  }
  assert.ok('OR' in locationBounds({ latitude: 0, longitude: 179.99, radiusKm: 5 }));
});

test('public projection and paging preserve coarse facts without exact pins or directions', () => {
  const visible = publicLocation({ ...center, locationLabel: 'Cordova', privateAddress: 'Private directions', transportationFee: 100 });
  assert.equal('latitude' in visible, false);
  assert.equal('longitude' in visible, false);
  assert.equal('privateAddress' in visible, false);
  assert.equal(visible.locationLabel, 'Cordova');
  const query = NearbyQuerySchema.parse({ latitude: 10, longitude: 123, radiusKm: 10, page: 8, limit: 2 });
  assert.deepEqual(nearbyPage([1, 2, 3], query), { items: [3], pagination: { page: 2, limit: 2, total: 3, totalPages: 2 } });
});

test('coverage checks actual new job locations and allows historical unlocated bookings', () => {
  assert.doesNotThrow(() => assertServiceCoverage({ latitude: null }, undefined));
  assert.throws(() => assertServiceCoverage({ ...center, coverageRadiusKm: 1 }, undefined), /job location/);
  assert.doesNotThrow(() => assertServiceCoverage({ ...center, coverageRadiusKm: 2 }, { ...center, latitude: 10.31 }));
  assert.throws(() => assertServiceCoverage({ ...center, coverageRadiusKm: 1 }, { ...center, latitude: 10.31 }), /outside/);
});

test('transportation is added once, including hourly and daily quantity bookings', () => {
  const price = new Prisma.Decimal(200), fee = new Prisma.Decimal(125.25);
  assert.equal(Number(calculateDirectListingTerms('PER_HOUR', price, 3, 60, fee).amount), 725.25);
  assert.equal(Number(calculateDirectListingTerms('PER_DAY', price, 3, 60, fee).amount), 725.25);
  assert.equal(Number(calculateDirectListingTerms('FIXED', price, 1, 60, fee).amount), 325.25);
  assert.equal(Number(calculateDirectListingTerms('PER_HOUR', price, 3, 60).amount), 600);
  assert.throws(() => calculateDirectListingTerms('FIXED', new Prisma.Decimal(49900), 1, 60, fee), /50,000/);
});
