import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { resolveDirectArrangement, resolveOfferArrangement, offerJobLocation, publicOffer, assertLocationForArrangementChange } from '../lib/service-arrangement';
import { CreateServiceSchema, UpdateServiceSchema } from './services.schema';
import { publicLocation } from '../lib/proximity';
import { calculateDirectListingTerms } from '../services/bookings/direct-listing-pricing';
import { DirectBookingSchema, OfferSchema, ServiceRequestSchema, ServiceRequestUpdateSchema } from './marketplace.schema';

const venue = { latitude: 10.3, longitude: 123.9, label: 'Cordova, Cebu', address: 'Private workshop directions' };
const job = { latitude: 10.301, longitude: 123.901, label: 'Day-as, Cordova', address: 'Private job directions' };
const base = { latitude: venue.latitude, longitude: venue.longitude, locationLabel: venue.label, venueAddress: venue.address, coverageRadiusKm: 2, transportationFee: new Prisma.Decimal(75) };
const request = { latitude: job.latitude, longitude: job.longitude, locationLabel: job.label, privateAddress: job.address };

test('remote publication accepts no area while physical listings and requests retain their location requirement',()=>{
  const listing={categoryId:'clxxxxxxxxxxxxxxxxxxxxxxx',title:'ONLINE TUTORING LESSONS',description:'An online tutoring lesson delivered using a video call.',price:300,estimatedDurationMins:60,paymentMethods:{cash:true,gcash:false}};
  const posting={categoryId:listing.categoryId,title:'ONLINE TUTORING HELP',description:listing.description,budgetMin:300,budgetMax:300,urgency:'This Week',paymentMethods:listing.paymentMethods};
  for(const location of [undefined,null]) {
    assert.equal(CreateServiceSchema.safeParse({...listing,serviceLocationMode:'REMOTE',serviceLocation:location}).success,true);
    assert.equal(ServiceRequestSchema.safeParse({...posting,serviceLocationMode:'REMOTE',jobLocation:location}).success,true);
    for(const mode of ['PROVIDER_VISITS','SEEKER_VISITS','BOTH']) {
      assert.equal(CreateServiceSchema.safeParse({...listing,serviceLocationMode:mode,serviceLocation:location}).success,false);
      assert.equal(ServiceRequestSchema.safeParse({...posting,serviceLocationMode:mode,jobLocation:location}).success,false);
    }
  }
  assert.equal(UpdateServiceSchema.safeParse({serviceLocationMode:'REMOTE',serviceLocation:null}).success,true);
  assert.equal(ServiceRequestUpdateSchema.safeParse({serviceLocationMode:'REMOTE',jobLocation:null}).success,true);
});

test('remote bookings ignore supplied pins and stale travel fees while retaining exact pricing', () => {
  const online = { ...base, serviceLocationMode: 'REMOTE' as const };
  for (const point of [undefined, job, { ...job, latitude: 80 }]) {
    const result = resolveDirectArrangement(online, undefined, point);
    assert.equal(result.serviceLocationMode, 'REMOTE');
    assert.equal(result.jobLocation, undefined);
    assert.equal(Number(result.transportationFee), 0);
    assert.equal(Number(calculateDirectListingTerms('PER_HOUR', new Prisma.Decimal(500), 3, 60, result.transportationFee).amount), 1500);
  }
  assert.throws(() => resolveDirectArrangement(online, 'PROVIDER_VISITS', job), { code: 'SERVICE_ARRANGEMENT_INVALID' });
  assert.throws(() => resolveDirectArrangement({ ...base, serviceLocationMode: 'BOTH' }, 'REMOTE'), { code: 'SERVICE_ARRANGEMENT_INVALID' });
});

test('remote offers require matching delivery modes and never carry a provider venue or job pin', () => {
  const onlineRequest = { ...request, serviceLocationMode: 'REMOTE' as const };
  const onlineService = { ...base, serviceLocationMode: 'REMOTE' as const };
  for (const service of [onlineService, null]) {
    const result = resolveOfferArrangement(onlineRequest, service, 'REMOTE', venue);
    assert.equal(result.providerVenue, undefined);
    assert.equal(offerJobLocation({ ...result, request: onlineRequest }), undefined);
  }
  assert.throws(() => resolveOfferArrangement(onlineRequest, base, 'REMOTE'), { code: 'SERVICE_ARRANGEMENT_INVALID' });
  assert.throws(() => resolveOfferArrangement({ ...request, serviceLocationMode: 'BOTH' }, onlineService, 'REMOTE'), { code: 'SERVICE_ARRANGEMENT_INVALID' });
});

test('remote booking contracts accept online work without a meetup location', () => {
  const serviceId = 'clxxxxxxxxxxxxxxxxxxxxxxx';
  assert.equal(DirectBookingSchema.safeParse({ serviceId, serviceLocationMode: 'REMOTE' }).success, true);
  assert.equal(OfferSchema.safeParse({ requestId: serviceId, offeredPrice: 500, estimatedDuration: 60, serviceLocationMode: 'REMOTE' }).success, true);
  assert.throws(() => assertLocationForArrangementChange('REMOTE', 'PROVIDER_VISITS', undefined, 'PROVIDER_VISITS'), {code:'SERVICE_ARRANGEMENT_INVALID'});
  assert.doesNotThrow(() => assertLocationForArrangementChange('SEEKER_VISITS','REMOTE',undefined,'PROVIDER_VISITS'));
  assert.throws(() => assertLocationForArrangementChange('REMOTE', 'SEEKER_VISITS', undefined, 'PROVIDER_VISITS'), { code: 'SERVICE_ARRANGEMENT_INVALID' });
  assert.throws(() => assertLocationForArrangementChange('REMOTE', 'PROVIDER_VISITS', undefined, 'SEEKER_VISITS'), { code: 'SERVICE_ARRANGEMENT_INVALID' });
});

test('traveling providers may publish a general service area without a physical operating address', () => {
  const result = CreateServiceSchema.safeParse({ categoryId:'clxxxxxxxxxxxxxxxxxxxxxxx', title:'LAPTOP REPAIR SERVICES', description:'Laptop diagnostics and repair at the seeker’s job location.', price:500, estimatedDurationMins:30, serviceLocationMode:'PROVIDER_VISITS', serviceLocation:{latitude:10.3,longitude:123.9,label:'Cordova, Cebu'}, coverageRadiusKm:10, paymentMethods:{cash:true,gcash:false} });
  assert.equal(result.success,true, JSON.stringify(result.error?.issues));
});

test('general discovery areas cannot silently become exact locations when arrangements change', () => {
  for (const [previous,next,areaMode] of [
    ['PROVIDER_VISITS','SEEKER_VISITS','PROVIDER_VISITS'], ['PROVIDER_VISITS','BOTH','PROVIDER_VISITS'],
    ['SEEKER_VISITS','PROVIDER_VISITS','SEEKER_VISITS'], ['SEEKER_VISITS','BOTH','SEEKER_VISITS'],
  ] as const) {
    assert.throws(() => assertLocationForArrangementChange(previous,next,undefined,areaMode), {code:'SERVICE_ARRANGEMENT_INVALID'});
    assert.doesNotThrow(() => assertLocationForArrangementChange(previous,next,job,areaMode));
  }
  assert.doesNotThrow(() => assertLocationForArrangementChange('BOTH','SEEKER_VISITS',undefined,'PROVIDER_VISITS'));
  assert.doesNotThrow(() => assertLocationForArrangementChange('PROVIDER_VISITS',undefined,undefined,'PROVIDER_VISITS'));
});

test('legacy listings keep provider visits, chosen job pin and one travel fee without a distance restriction', () => {
  const result = resolveDirectArrangement(base, undefined, job);
  assert.equal(result.serviceLocationMode, 'PROVIDER_VISITS');
  assert.deepEqual(result.jobLocation, job);
  assert.equal(Number(result.transportationFee), 75);
  assert.equal(Number(calculateDirectListingTerms('PER_HOUR', new Prisma.Decimal(500), 3, 60, result.transportationFee).amount), 1575);
  assert.throws(() => resolveDirectArrangement(base), { code: 'JOB_LOCATION_REQUIRED' });
  assert.doesNotThrow(() => resolveDirectArrangement(base, 'PROVIDER_VISITS', { ...job, latitude: 11 }));
});

test('seeker visits use the authoritative venue without provider travel fees or home coverage', () => {
  const result = resolveDirectArrangement({ ...base, serviceLocationMode: 'SEEKER_VISITS' }, 'SEEKER_VISITS', { ...job, latitude: 11 });
  assert.deepEqual(result.jobLocation, venue);
  assert.equal(Number(result.transportationFee), 0);
  assert.equal(Number(calculateDirectListingTerms('FIXED', new Prisma.Decimal(1500), 1, 60, result.transportationFee).amount), 1500);
  assert.throws(() => resolveDirectArrangement({ serviceLocationMode: 'SEEKER_VISITS' }), { code: 'SERVICE_ARRANGEMENT_INVALID' });
});

test('both requires a concrete choice and fixed listings reject unsupported arrangements', () => {
  assert.throws(() => resolveDirectArrangement({ ...base, serviceLocationMode: 'BOTH' }, undefined, job), { code: 'SERVICE_ARRANGEMENT_INVALID' });
  assert.throws(() => resolveDirectArrangement(base, 'SEEKER_VISITS', job), { code: 'SERVICE_ARRANGEMENT_INVALID' });
  assert.deepEqual(resolveDirectArrangement({ ...base, serviceLocationMode: 'BOTH' }, 'SEEKER_VISITS').jobLocation, venue);
  assert.throws(() => resolveOfferArrangement(request, { ...base, serviceLocationMode: 'SEEKER_VISITS' }, 'PROVIDER_VISITS'), { code: 'SERVICE_ARRANGEMENT_INVALID' });
});

test('custom offers supply a private venue; linked offers use the saved venue', () => {
  const flexible = { ...request, serviceLocationMode: 'BOTH' as const };
  assert.throws(() => resolveOfferArrangement(flexible, null, 'SEEKER_VISITS'), { code: 'SERVICE_ARRANGEMENT_INVALID' });
  assert.deepEqual(resolveOfferArrangement(flexible, null, 'SEEKER_VISITS', venue).providerVenue, venue);
  const offered = resolveOfferArrangement(flexible, { ...base, serviceLocationMode: 'BOTH' }, 'SEEKER_VISITS', job);
  assert.deepEqual(offered.providerVenue, venue);
  assert.deepEqual(offerJobLocation({ ...offered, request: flexible }), venue);
  assert.deepEqual(offerJobLocation({ request }), job);
  assert.throws(() => resolveOfferArrangement(request, base, 'SEEKER_VISITS', venue), { code: 'SERVICE_ARRANGEMENT_INVALID' });
});

test('unpaid offer previews and public listings strip exact venue information', () => {
  const visible = publicOffer({ id: 'offer', providerVenue: venue, serviceLocationMode: 'SEEKER_VISITS' });
  assert.equal(visible.venueLabel, venue.label);
  assert.equal('providerVenue' in visible, false);
  assert.equal(JSON.stringify(visible).includes(venue.address), false);
  const listing = publicLocation(base);
  for (const field of ['latitude', 'longitude', 'venueAddress']) assert.equal(field in listing, false);
});

test('booking and offer contracts reject BOTH as an agreed arrangement', () => {
  const id = 'clxxxxxxxxxxxxxxxxxxxxxxx';
  assert.equal(DirectBookingSchema.safeParse({ serviceId: id, serviceLocationMode: 'BOTH' }).success, false);
  assert.equal(DirectBookingSchema.safeParse({ serviceId: id, serviceLocationMode: 'SEEKER_VISITS' }).success, true);
  assert.equal(OfferSchema.safeParse({ requestId: id, offeredPrice: 500, estimatedDuration: 60, serviceLocationMode: 'BOTH' }).success, false);
});

test('physical delivery keeps fixed and metered posted pricing, with a single travel fee', () => {
  const arrangement = resolveDirectArrangement(base, 'PROVIDER_VISITS', { ...job, latitude: 11 });
  assert.equal(Number(calculateDirectListingTerms('FIXED', new Prisma.Decimal(300), 1, 60, arrangement.transportationFee).amount), 375);
  for (const type of ['PER_HOUR', 'PER_DAY'] as const) assert.equal(Number(calculateDirectListingTerms(type, new Prisma.Decimal(300), 2, 60, arrangement.transportationFee).amount), 675);
});
