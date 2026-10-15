import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { createService, updateService } from '../services/services.service';
import { createRequest, updateRequest } from '../services/requests.service';
import { submitOffer } from '../services/offers.service';
import { createDirectFromOfferService, createDirectRequest } from '../services/bookings/direct-bookings.service';
import { initiateOnlinePayment } from '../services/payment-attempt.service';
import { nearbyServices, nearbyRequests } from '../services/nearby.service';
import { CreateServiceSchema } from '../schema/services.schema';
import { NearbyQuerySchema } from '../schema/location.schema';

test('discovery stays independent of physical arrangements, private addresses and payment snapshots', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '',/^servicehub_migration_test_[a-f0-9]{32}$/);
  assert.equal(env.NODE_ENV,'test');
  t.after(() => prisma.$disconnect());
  const suffix = randomUUID();
  const users = [];
  for (const name of ['Provider','CashSeeker','OnlineSeeker','DirectSeeker']) users.push(await prisma.user.create({data:{name,email:`discovery-${name}-${suffix}@example.test`,passwordHash:'test-only',phone:'test-only',location:'Cordova, Cebu',gcashNumber:'09123456789',emailVerified:true,verificationStatus:'APPROVED'}}));
  const [provider,cashSeeker,onlineSeeker,directSeeker] = users;
  const category = await prisma.category.findUniqueOrThrow({where:{name:'Computer & Laptop Repair'}});
  const discovery = {latitude:10.3,longitude:123.9,label:'Ibabao, Cordova, Cebu'};
  const workplace = 'Shop 2 beside the Cordova barangay hall';
  const service = await createService(provider.id,CreateServiceSchema.parse({categoryId:category.id,title:'COMPUTER DIAGNOSTICS SERVICE',description:'I diagnose computer and laptop problems and explain the repairs needed.',price:300,estimatedDurationMins:60,paymentMethods:{cash:true,gcash:true},serviceLocationMode:'PROVIDER_VISITS',serviceLocation:discovery,transportationFee:75}));
  const createPublic = (seekerId:string,title:string) => createRequest(seekerId,{categoryId:category.id,title,description:'My laptop fan is noisy. I need a technician to inspect and repair it.',budgetMin:500,budgetMax:2500,urgency:'This Week',paymentMethods:{cash:true,gcash:true},serviceLocationMode:'PROVIDER_VISITS',jobLocation:discovery});
  const request = await createPublic(cashSeeker.id,'LAPTOP FAN REPAIR');

  for (const mode of ['SEEKER_VISITS','BOTH','PROVIDER_VISITS'] as const) {
    const changedService = await updateService(service.id,provider.id,{serviceLocationMode:mode,venueAddress:workplace});
    const changedRequest = await updateRequest(request.id,cashSeeker.id,{serviceLocationMode:mode});
    for (const saved of [changedService,changedRequest]) {
      assert.equal(saved.latitude,discovery.latitude);
      assert.equal(saved.longitude,discovery.longitude);
      assert.equal(saved.locationLabel,discovery.label);
    }
  }
  const query = NearbyQuerySchema.parse({latitude:discovery.latitude,longitude:discovery.longitude,radiusKm:.5,category:category.name});
  const services = await nearbyServices(query), requests = await nearbyRequests(query,provider.id);
  assert.ok(services.items.some(row => row.id === service.id));
  assert.ok(requests.items.some(row => row.id === request.id));
  assert.ok(services.mapPins.some(pin => pin.id === service.id));
  assert.ok(requests.mapPins.some(pin => pin.id === request.id));
  assert.equal(JSON.stringify(services).includes(workplace),false);

  const cashOffer = await submitOffer(provider.id,{requestId:request.id,offeredPrice:2500,estimatedDuration:60,serviceLocationMode:'PROVIDER_VISITS'});
  await assert.rejects(createDirectFromOfferService(cashOffer.id,cashSeeker.id),{code:'JOB_LOCATION_REQUIRED'});
  const address = {label:'Job address',address:'Blue gate beside the Ibabao barangay hall'};
  const booking = await createDirectFromOfferService(cashOffer.id,cashSeeker.id,address);
  assert.deepEqual(booking.jobLocation,address);
  assert.equal(Number(booking.agreedAmount),2500);
  const savedRequest = await prisma.serviceRequest.findUniqueOrThrow({where:{id:request.id}});
  assert.equal(savedRequest.latitude,discovery.latitude);
  assert.equal(savedRequest.privateAddress,null);

  await updateService(service.id,provider.id,{serviceLocationMode:'BOTH',venueAddress:workplace});
  const shopBooking = await createDirectRequest({seekerId:directSeeker.id,providerId:provider.id,serviceId:service.id,serviceLocationMode:'SEEKER_VISITS'});
  assert.deepEqual(shopBooking.booking.jobLocation,{label:discovery.label,address:workplace});
  assert.equal(Number(shopBooking.booking.agreedAmount),300);
  assert.equal(Number(shopBooking.booking.transportationFee),0);

  const onlineRequest = await createPublic(onlineSeeker.id,'LAPTOP COOLING SYSTEM REPAIR');
  const onlineOffer = await submitOffer(provider.id,{requestId:onlineRequest.id,offeredPrice:1800,estimatedDuration:60,serviceLocationMode:'PROVIDER_VISITS'});
  const keys = [env.PAYMONGO_PUBLIC_KEY,env.PAYMONGO_SECRET_KEY,env.PAYMONGO_WEBHOOK_SECRET];
  const originalFetch = globalThis.fetch;
  let intents = 0;
  try {
    env.PAYMONGO_PUBLIC_KEY='pk_test_discovery';env.PAYMONGO_SECRET_KEY='sk_test_discovery';env.PAYMONGO_WEBHOOK_SECRET='whsec_test_discovery';
    globalThis.fetch = async (input,options) => {
      const url = String(input);
      if (url.endsWith('/payment_intents')) {
        assert.equal(JSON.parse(String(options?.body)).data.attributes.amount,180000);
        return Response.json({data:{id:`pi_discovery_${suffix}_${++intents}`,attributes:{client_key:'test-client'}}});
      }
      if (url.endsWith('/payment_methods')) return Response.json({data:{id:'pm_discovery'}});
      if (url.endsWith('/attach')) return Response.json({data:{attributes:{status:'awaiting_next_action',next_action:{type:'redirect',redirect:{url:'https://test-sources.paymongo.com/sources/discovery'}}}}});
      throw new Error('Unexpected external test request');
    };
    const payment = await initiateOnlinePayment({seekerId:onlineSeeker.id,offerId:onlineOffer.id,jobLocation:address,paymentMethod:'gcash'});
    assert.deepEqual(payment.jobLocation,address);
    assert.equal(Number(payment.amount),1800);
    assert.equal(intents,1);
    await assert.rejects(initiateOnlinePayment({seekerId:onlineSeeker.id,offerId:onlineOffer.id,jobLocation:{...address,address:'A different job address'},paymentMethod:'gcash'}),/already pending for another job location/);
    await prisma.paymentAttempt.update({where:{id:payment.id},data:{status:'FAILED'}});
    await prisma.offer.update({where:{id:onlineOffer.id},data:{status:'PENDING'}});
    await prisma.serviceRequest.update({where:{id:onlineRequest.id},data:{status:'OPEN'}});
    const retry = await initiateOnlinePayment({seekerId:onlineSeeker.id,offerId:onlineOffer.id,retryPaymentIntentId:payment.providerIntentId!,paymentMethod:'gcash'});
    assert.deepEqual(retry.jobLocation,address,'retry retains the owned attempt job address');
    assert.equal(Number(retry.amount),1800);
    assert.equal(intents,2);
  } finally {
    [env.PAYMONGO_PUBLIC_KEY,env.PAYMONGO_SECRET_KEY,env.PAYMONGO_WEBHOOK_SECRET]=keys;
    globalThis.fetch=originalFetch;
  }
  await updateService(service.id,provider.id,{serviceLocation:{...discovery,latitude:10.4}});
  assert.deepEqual((await prisma.booking.findUniqueOrThrow({where:{id:shopBooking.booking.id}})).jobLocation,shopBooking.booking.jobLocation,'editing discovery never rewrites an existing booking');
});
