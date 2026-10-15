import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { createDirectRequest, createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { submitOffer, listReceivedOffers } from '../services/offers.service';
import { updateRequest } from '../services/requests.service';
import { createListingInquiry } from '../services/listing-inquiries.service';
import { matchProvidersToRequest, matchRequestsToService } from '../services/ai-marketplace.service';

test('both marketplace directions persist the agreed arrangement, private pin and correct price', async t => {
  // This suite must never create bookings or remove data in a live schema.
  const schema = new URL(env.DATABASE_URL!).searchParams.get('schema');
  assert.match(schema || '', /^servicehub_migration_test_[a-f0-9]+$/, 'Run only in a disposable schema using test:fresh-migrations.');
  assert.equal(env.NODE_ENV, 'test');
  t.after(() => prisma.$disconnect());
  const suffix = Date.now().toString();
  const category = await prisma.category.create({ data: { name: `Arrangement ${suffix}` } });
  const users = [];
  for (const role of ['provider', 'seeker-a', 'seeker-b', 'seeker-c']) {
    users.push(await prisma.user.create({ data: { name: role, email: `${role}-${suffix}@example.test`, passwordHash: 'test-only', phone: `09${suffix.slice(-8)}${users.length}`, location: '', emailVerified: true, verificationStatus: 'APPROVED' } }));
  }
  const [provider, seekerA, seekerB, seekerC] = users;
  const service = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: 'LAPTOP REPAIR SERVICES', description: 'Repair a laptop at a workshop or job site.', titleNormalized: `arrangement-${suffix}`, price: 1500, priceType: 'FIXED', estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: true }, status: 'ACTIVE', isAvailable: true, serviceLocationMode: 'BOTH', latitude: 10.3, longitude: 123.9, locationLabel: 'Cordova workshop', venueAddress: 'Private workshop entrance', coverageRadiusKm: 2, transportationFee: 75 } });
  const job = { latitude: 10.301, longitude: 123.901, label: 'Day-as job site', address: 'Private job entrance' };
  const venueBooking = await createDirectRequest({ seekerId: seekerA.id, providerId: provider.id, serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', jobLocation: job });
  assert.equal(venueBooking.booking.serviceLocationMode, 'SEEKER_VISITS');
  assert.deepEqual(venueBooking.booking.jobLocation, { latitude: 10.3, longitude: 123.9, label: 'Cordova workshop', address: 'Private workshop entrance' });
  assert.equal(Number(venueBooking.booking.agreedAmount), 1500);
  assert.equal(Number(venueBooking.booking.transportationFee), 0);
  const travelBooking = await createDirectRequest({ seekerId: seekerB.id, providerId: provider.id, serviceId: service.id, serviceLocationMode: 'PROVIDER_VISITS', jobLocation: job });
  assert.deepEqual(travelBooking.booking.jobLocation, job);
  assert.equal(Number(travelBooking.booking.agreedAmount), 1575);

  const request = await prisma.serviceRequest.create({ data: { seekerId: seekerC.id, categoryId: category.id, title: 'Repair at provider venue', description: 'I will visit the provider workshop.', budgetMin: 500, budgetMax: 2000, urgency: 'This Week', serviceLocationMode: 'SEEKER_VISITS', latitude: 11, longitude: 123, locationLabel: 'Seeker search area', paymentMethods: { cash: true, gcash: true } } });
  const offer = await submitOffer(provider.id, { requestId: request.id, serviceId: service.id, offeredPrice: 1400, estimatedDuration: 60, serviceLocationMode: 'SEEKER_VISITS' });
  assert.equal('providerVenue' in offer, false);
  assert.equal(offer.venueLabel, 'Cordova workshop');
  const previews = await listReceivedOffers(seekerC.id);
  assert.equal(JSON.stringify(previews).includes('Private workshop entrance'), false);
  await assert.rejects(() => updateRequest(request.id, seekerC.id, { serviceLocationMode: 'BOTH', jobLocation: job }), /already has offers/);
  await prisma.service.update({ where: { id: service.id }, data: { locationLabel: 'Changed venue', latitude: 10.4, venueAddress: 'Changed directions' } });
  const bookedOffer = await createDirectFromOfferService(offer.id, seekerC.id);
  assert.equal(bookedOffer.serviceLocationMode, 'SEEKER_VISITS');
  assert.deepEqual(bookedOffer.jobLocation, venueBooking.booking.jobLocation);
  assert.equal(Number(bookedOffer.agreedAmount), 1400);
  assert.equal(bookedOffer.transportationFee, null);

  await t.test('remote bookings and reciprocal matching retain online delivery without private venue data', async () => {
    const previousKey = env.GEMINI_API_KEY;
    env.GEMINI_API_KEY = undefined;
    try {
      const remoteSeeker = await prisma.user.create({ data: { name:'Remote seeker',email:`remote-${suffix}@example.test`,passwordHash:'test-only',phone:'fixture',location:'Cordova',emailVerified:true,verificationStatus:'APPROVED' } });
      const remoteService = await prisma.service.create({ data: { providerId:provider.id,categoryId:category.id,title:'WEBSITE DESIGN SERVICE',titleNormalized:`remote-${suffix}`,description:'Build a website online without a meetup.',price:1500,priceType:'FIXED',estimatedDurationMins:60,paymentMethods:{cash:true,gcash:true},status:'ACTIVE',isAvailable:true,serviceLocationMode:'REMOTE',latitude:10.3,longitude:123.9,locationLabel:'Cordova',venueAddress:'STALE PRIVATE VENUE',coverageRadiusKm:1,transportationFee:999 } });
      const remoteBooking = await createDirectRequest({ seekerId:remoteSeeker.id,providerId:provider.id,serviceId:remoteService.id,serviceLocationMode:'REMOTE',jobLocation:job });
      assert.equal(remoteBooking.booking.serviceLocationMode,'REMOTE');
      assert.equal(remoteBooking.booking.jobLocation,null);
      assert.equal(Number(remoteBooking.booking.agreedAmount),1500);
      assert.equal(Number(remoteBooking.booking.transportationFee),0);
      const remoteRequest = await prisma.serviceRequest.create({ data: { seekerId:seekerA.id,categoryId:category.id,title:'Build a website online',description:'Create a five-page website without an in-person meeting.',budgetMin:500,budgetMax:2000,urgency:'This Week',serviceLocationMode:'REMOTE',latitude:10.3,longitude:123.9,locationLabel:'Cordova',paymentMethods:{cash:true,gcash:true} } });
      assert.deepEqual((await matchProvidersToRequest(remoteRequest.id,seekerA.id)).suggestions.map(item=>item.id),[remoteService.id]);
      assert.deepEqual((await matchRequestsToService(remoteService.id,provider.id)).suggestions.map(item=>item.id),[remoteRequest.id]);
      await prisma.service.update({ where:{id:remoteService.id},data:{priceType:'BY_AGREEMENT',price:null} });
      const inquiry = await createListingInquiry(seekerB.id,{serviceId:remoteService.id,serviceLocationMode:'REMOTE',message:'Build a five-page website with a contact form.'});
      assert.equal(inquiry.privateAddress,undefined);
      assert.equal((await prisma.serviceRequest.findUniqueOrThrow({where:{id:inquiry.id}})).privateAddress,null);
      const remoteOffer = await submitOffer(provider.id,{requestId:inquiry.id,serviceId:remoteService.id,offeredPrice:1400,estimatedDuration:60,serviceLocationMode:'REMOTE',providerVenue:job,message:'Five website pages and one contact form, delivered online.'});
      assert.equal(remoteOffer.venueLabel,undefined);
      const remoteOfferBooking = await createDirectFromOfferService(remoteOffer.id,seekerB.id);
      assert.equal(remoteOfferBooking.serviceLocationMode,'REMOTE');
      assert.equal(remoteOfferBooking.jobLocation,null);
      assert.equal(Number(remoteOfferBooking.agreedAmount),1400);
    } finally { env.GEMINI_API_KEY = previousKey; }
  });
});
