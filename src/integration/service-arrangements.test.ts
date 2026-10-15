import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { createDirectRequest, createDirectFromOfferService } from '../services/bookings/direct-bookings.service';
import { submitOffer, listReceivedOffers } from '../services/offers.service';
import { createRequest, updateRequest, getMyRequests, listRequests } from '../services/requests.service';
import { createService, updateService } from '../services/services.service';
import { CreateServiceSchema } from '../schema/services.schema';
import { nearbyServices, nearbyRequests } from '../services/nearby.service';
import { NearbyQuerySchema } from '../schema/location.schema';
import { createListingInquiry } from '../services/listing-inquiries.service';
import { matchProvidersToRequest, matchRequestsToService } from '../services/ai-marketplace.service';
import { initiateOnlinePayment } from '../services/payment-attempt.service';

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
    users.push(await prisma.user.create({ data: { name: role, email: `${role}-${suffix}@example.test`, passwordHash: 'test-only', phone: `09${suffix.slice(-8)}${users.length}`, gcashNumber: '09123456789', location: '', emailVerified: true, verificationStatus: 'APPROVED' } }));
  }
  const [provider, seekerA, seekerB, seekerC] = users;
  const service = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: 'LAPTOP REPAIR SERVICES', description: 'Repair a laptop at a workshop or job site.', titleNormalized: `arrangement-${suffix}`, price: 1500, priceType: 'FIXED', estimatedDurationMins: 60, paymentMethods: { cash: true, gcash: true }, status: 'ACTIVE', isAvailable: true, serviceLocationMode: 'BOTH', latitude: 10.3, longitude: 123.9, locationLabel: 'Cordova workshop', venueAddress: 'Private workshop entrance', coverageRadiusKm: 2, transportationFee: 75 } });
  const job = { latitude: 10.301, longitude: 123.901, label: 'Day-as job site', address: 'Private job entrance' };
  await t.test('fixed-price jobs outside an old travel radius book at posted terms and cannot enter quote negotiation', async () => {
    const farJob = { ...job, latitude: 11.3, label: 'Distant job area' };
    const keys = [env.PAYMONGO_PUBLIC_KEY, env.PAYMONGO_SECRET_KEY, env.PAYMONGO_WEBHOOK_SECRET];
    const originalFetch = globalThis.fetch;
    let intents = 0;
    try {
      env.PAYMONGO_PUBLIC_KEY = 'pk_test_synthetic'; env.PAYMONGO_SECRET_KEY = 'sk_test_synthetic'; env.PAYMONGO_WEBHOOK_SECRET = 'synthetic';
      globalThis.fetch = async input => {
        const url = String(input);
        if (url.endsWith('/payment_intents')) return Response.json({ data:{ id:`pi_arrangement_${suffix}_${++intents}`, attributes:{client_key:'test_client'} } });
        if (url.endsWith('/payment_methods')) return Response.json({data:{id:`pm_arrangement_${suffix}`}});
        if (url.endsWith('/attach')) return Response.json({data:{attributes:{status:'awaiting_next_action',next_action:{type:'redirect',redirect:{url:'https://test-sources.paymongo.com/sources/arrangement'}}}}});
        if (url.includes('/payment_intents/pi_arrangement_')) return Response.json({data:{id:url.split('/').at(-1),attributes:{status:'awaiting_next_action',amount:157500,currency:'PHP',payments:[]}}});
        throw new Error('Unexpected payment request');
      };
      await assert.rejects(createListingInquiry(seekerA.id, {serviceId:service.id,serviceLocationMode:'PROVIDER_VISITS',jobLocation:farJob,message:'Repair my laptop at this job location.'}), {code:'FIXED_PRICE_BOOKING_REQUIRED'});
      assert.equal(await prisma.serviceRequest.count({where:{targetServiceId:service.id}}),0);
      const args = {seekerId:seekerA.id,serviceId:service.id,serviceLocationMode:'PROVIDER_VISITS' as const,jobLocation:farJob,paymentMethod:'gcash' as const};
      const attempt = await initiateOnlinePayment(args);
      assert.equal(Number(attempt.amount),1575); assert.deepEqual(attempt.jobLocation,farJob);
      assert.equal(attempt.serviceLocationMode,'PROVIDER_VISITS');
      assert.equal((await initiateOnlinePayment(args)).id,attempt.id); assert.equal(intents,1);
      assert.equal(await prisma.booking.count({where:{serviceId:service.id}}),0,'checkout preparation alone is not a booking');
      await prisma.paymentAttempt.delete({where:{id:attempt.id}});
      const legacy = await prisma.serviceRequest.create({data:{seekerId:seekerA.id,categoryId:category.id,targetProviderId:provider.id,targetServiceId:service.id,title:'Old fixed-price inquiry',description:'Created by the previous incorrect flow.',budgetMin:0,budgetMax:0,urgency:'This Week',serviceLocationMode:'PROVIDER_VISITS',latitude:farJob.latitude,longitude:farJob.longitude,locationLabel:farJob.label,paymentMethods:{cash:true,gcash:true}}});
      assert.deepEqual((await getMyRequests(seekerA.id)).find(row=>row.id===legacy.id)?.targetService,{priceType:'FIXED',price:new (await import('@prisma/client')).Prisma.Decimal(1500)});
      assert.equal((await listRequests(undefined,provider.id,undefined,[legacy.id]))[0].targetService?.priceType,'FIXED');
      await assert.rejects(submitOffer(provider.id,{requestId:legacy.id,serviceId:service.id,offeredPrice:1800,estimatedDuration:60,message:'Changed price is not allowed.'}),{code:'FIXED_PRICE_BOOKING_REQUIRED'});
      assert.equal(await prisma.offer.count({where:{requestId:legacy.id}}),0);
      await prisma.serviceRequest.update({where:{id:legacy.id},data:{status:'CANCELED'}});
    } finally {
      [env.PAYMONGO_PUBLIC_KEY, env.PAYMONGO_SECRET_KEY, env.PAYMONGO_WEBHOOK_SECRET] = keys;
      globalThis.fetch = originalFetch;
    }
  });
  const venueBooking = await createDirectRequest({ seekerId: seekerA.id, providerId: provider.id, serviceId: service.id, serviceLocationMode: 'SEEKER_VISITS', jobLocation: job });
  assert.equal(venueBooking.booking.serviceLocationMode, 'SEEKER_VISITS');
  assert.deepEqual(venueBooking.booking.jobLocation, { label: 'Cordova workshop', address: 'Private workshop entrance' });
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
  await t.test('remote creation and physical-to-remote edits save without coordinates and stay discoverable',async()=>{
    const remoteCategory=await prisma.category.findUniqueOrThrow({where:{name:'Tutoring & Lessons'}});
    const created=await createService(provider.id,CreateServiceSchema.parse({categoryId:remoteCategory.id,title:'ONLINE TUTORING LESSONS',description:'I teach mathematics in online video lessons for students.',price:300,estimatedDurationMins:60,paymentMethods:{cash:true,gcash:false},serviceLocationMode:'REMOTE'}));
    assert.equal(created.latitude,null);assert.equal(created.longitude,null);assert.equal(created.publicMapPin,false);
    for(const mode of ['PROVIDER_VISITS','SEEKER_VISITS','BOTH'] as const) {
      await assert.rejects(updateService(created.id,provider.id,{serviceLocationMode:mode}),/Choose your discovery location/);
      await updateService(created.id,provider.id,{serviceLocationMode:mode,serviceLocation:job,venueAddress:job.address,publicMapPin:true});
      const converted=await updateService(created.id,provider.id,{serviceLocationMode:'REMOTE',serviceLocation:null});
      assert.equal(converted.latitude,null);assert.equal(converted.longitude,null);assert.equal(converted.locationLabel,null);
      assert.equal(converted.venueAddress,null);assert.equal(converted.publicMapPin,false);assert.equal(converted.transportationFee,null);
    }
    const posted=await createRequest(seekerC.id,{categoryId:remoteCategory.id,title:'ONLINE MATH TUTORING HELP',description:'I need mathematics tutoring using online video lessons.',budgetMin:300,budgetMax:300,urgency:'This Week',paymentMethods:{cash:true,gcash:false},serviceLocationMode:'REMOTE'});
    assert.equal(posted.latitude,null);
    await updateRequest(posted.id,seekerC.id,{serviceLocationMode:'PROVIDER_VISITS',jobLocation:job});
    const converted=await updateRequest(posted.id,seekerC.id,{serviceLocationMode:'REMOTE',jobLocation:null});
    assert.equal(converted.latitude,null);assert.equal(converted.privateAddress,null);
    const query=NearbyQuerySchema.parse({latitude:50,longitude:50,radiusKm:.5,category:'Tutoring & Lessons'});
    const services=await nearbyServices(query),requests=await nearbyRequests(query,provider.id);
    assert.ok(services.items.some(item=>item.id===created.id&&item.distanceKm===null));
    assert.ok(requests.items.some(item=>item.id===posted.id&&item.distanceKm===null));
    assert.deepEqual(services.mapPins,[]);assert.deepEqual(requests.mapPins,[]);
    await assert.rejects(updateService(created.id,provider.id,{serviceLocationMode:'SEEKER_VISITS',serviceLocation:null}),/Choose your discovery location/);
    await assert.rejects(updateRequest(posted.id,seekerC.id,{serviceLocationMode:'PROVIDER_VISITS',jobLocation:null}),/Choose your discovery location/);
  });
});
