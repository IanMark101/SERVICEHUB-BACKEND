import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { initSocket } from '../lib/socket';
import { requestCancellation, performImmediateCancel, respondToCancellationRequest, escalateCancellationRequest } from '../services/cancellation.service';
import { createCompletionEscalation } from '../services/completion-escalation.service';
import { createSafetyReport } from '../services/safety-report.service';
import { submitTrustCase, decideTrustCase } from '../controllers/trust-cases.controller';
import { confirmCompletionService, disputeJobService } from '../services/bookings/completion.service';
import { rejectOffer } from '../services/offers.service';
import { cancelRequest } from '../services/requests.service';
import { deleteService } from '../services/services.service';
import { markOneAsRead, markAllAsRead } from '../controllers/notifications.controller';

test('persisted notification delivery across both participants and administrative workflows',async t=>{
  const schema=new URL(env.DATABASE_URL).searchParams.get('schema')||'';
  assert.match(schema,/^audit_20260924_[a-f0-9]{32}$/,'fixtures must never use the application schema');
  t.after(async () => { await prisma.$disconnect(); });
  const suffix=randomUUID();
  const makeUser=(name:string,extra={})=>prisma.user.create({data:{name,email:`notification-${name}-${suffix}@example.test`,passwordHash:'unusable-test-hash',phone:'09123456789',location:'Cordova, Cebu',emailVerified:true,verificationStatus:'APPROVED',...extra}});
  const seeker=await makeUser('seeker'),provider=await makeUser('provider'),secondProvider=await makeUser('second-provider');
  const admin=await makeUser('admin',{role:'admin'}),inactive=await makeUser('inactive-admin',{role:'admin',isActive:false});
  const category=await prisma.category.findFirst({where:{isActive:true}})||await prisma.category.create({data:{name:'Plumbing'}});
  const booking = async (status: 'ACCEPTED' | 'AWAITING_CONFIRMATION' | 'CANCELED' = 'ACCEPTED') => {
    // Each independent scenario uses its own listing. Keep the real one-active-
    // booking-per-seeker/listing database guard in place for disputed work.
    const title = `Notification fixture repair ${randomUUID()}`;
    const service = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title, titleNormalized: title.toLowerCase(), description: 'Repair work for isolated notification checks.', price: 500, priceType: 'FIXED', estimatedDurationMins: 60, status: 'ACTIVE', isAvailable: true, paymentMethods: { cash: true, gcash: false } } });
    return prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: service.id, agreedAmount: 500, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID', status, started: status === 'AWAITING_CONFIRMATION' } });
  };
  const request=(extra={})=>prisma.serviceRequest.create({data:{seekerId:seeker.id,categoryId:category.id,title:'Isolated laptop repair request',description:'A synthetic laptop needs diagnosis and repair.',budgetMin:100,budgetMax:1000,urgency:'Within a week',status:'OPEN',paymentMethods:{cash:true,gcash:false},...extra}});
  const offer=(requestId:string,providerId=provider.id)=>prisma.offer.create({data:{requestId,providerId,offeredPrice:500,estimatedDuration:60,message:'Diagnosis and basic repair are included.',status:'PENDING'}});
  const io=initSocket(createServer());t.after(()=>{io.close();});
  const emitted:{room:string;event:string;data:{title?:string}}[]=[];
  t.mock.method(io,'to',(room:string)=>({emit:(event:string,data:{title?:string})=>emitted.push({room,event,data})}));

  for(const actor of [seeker,provider])await t.test(`${actor.name} cancellation persists one alert per participant and retries do not duplicate`,async()=>{
    const work=await booking();emitted.length=0;await requestCancellation(work.id,actor.id,'Unable to continue with this booking.');
    const alerts=await prisma.notification.findMany({where:{title:'Booking cancelled',link:{contains:`booking=${work.id}`}}});
    assert.deepEqual(new Set(alerts.map(row=>row.userId)),new Set([seeker.id,provider.id]));assert.equal(alerts.length,2);
    for(const user of [seeker,provider])assert.ok(emitted.some(event=>event.room===`user:${user.id}`&&event.event==='notification'&&event.data.title==='Booking cancelled'));
    await requestCancellation(work.id,actor.id,'Unable to continue with this booking.');await performImmediateCancel(work.id,actor.id);
    assert.equal(await prisma.notification.count({where:{title:'Booking cancelled',link:{contains:`booking=${work.id}`}}}),2);
    assert.equal(await prisma.message.count({where:{bookingId:work.id,isSystem:true,content:'Booking cancelled.'}}),1);
  });
  await t.test('legacy provider-only history receives the missing seeker alert once',async()=>{
    const work=await booking('CANCELED');await prisma.notification.create({data:{userId:provider.id,title:'Booking cancelled',body:'The booking has been cancelled.',link:`/provider/provider-activity?tab=canceled&booking=${work.id}`}});
    await prisma.message.create({data:{bookingId:work.id,senderId:seeker.id,receiverId:provider.id,isSystem:true,content:'Booking cancelled.'}});
    await performImmediateCancel(work.id,seeker.id);await performImmediateCancel(work.id,seeker.id);
    assert.equal(await prisma.notification.count({where:{title:'Booking cancelled',link:{contains:`booking=${work.id}`}}}),2);
    assert.equal(await prisma.message.count({where:{bookingId:work.id}}),1);
  });
  await t.test('completion confirmation persists alerts for both participants once',async()=>{
    const work=await booking('AWAITING_CONFIRMATION');await confirmCompletionService(work.id,seeker.id);await confirmCompletionService(work.id,seeker.id);
    const alerts=await prisma.notification.findMany({where:{title:'Completion confirmed',link:{contains:`booking=${work.id}`}}});
    assert.equal(alerts.length,2);assert.deepEqual(new Set(alerts.map(row=>row.userId)),new Set([seeker.id,provider.id]));
  });
  await t.test('completion disputes reach active administrators and the provider',async()=>{
    const work=await booking('AWAITING_CONFIRMATION');const report=await disputeJobService(work.id,seeker.id,'INCOMPLETE_SERVICE');
    const alerts=await prisma.notification.findMany({where:{title:'Completion dispute requires review',link:`/admin/reports?report=${report.id}`}});
    assert.equal(alerts.length,1);assert.equal(alerts[0].userId,admin.id);assert.notEqual(alerts[0].userId,inactive.id);
    assert.equal(await prisma.notification.count({where:{userId:provider.id,title:'Completion disputed',link:{contains:`booking=${work.id}`}}}),1);
  });
  await t.test('withdrawn public offers notify the seeker without closing the public request',async()=>{
    const post=await request();const bid=await offer(post.id);await rejectOffer(bid.id,provider.id);await rejectOffer(bid.id,provider.id);
    assert.equal(await prisma.notification.count({where:{userId:seeker.id,title:'Offer withdrawn',id:`offer-withdrawn:${bid.id}`}}),1);
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({where:{id:post.id}})).status,'OPEN');
  });
  await t.test('active safety reviews notify both participants neutrally and active admins once', async () => {
    const work = await booking();
    const input = { bookingId: work.id, reporterId: seeker.id, reason: 'INAPPROPRIATE_BEHAVIOR' as const, description: 'Private allegation used only in this isolated test.' };
    const report = await createSafetyReport(input);
    await createSafetyReport(input);
    const alerts = await prisma.notification.findMany({ where: { title: 'Booking under review', link: { contains: `booking=${work.id}` } } });
    assert.deepEqual(new Set(alerts.map(row => row.userId)), new Set([seeker.id, provider.id]));
    assert.equal(alerts.length, 2);
    assert.ok(alerts.every(row => !row.body.includes(input.description)));
    const admins = await prisma.notification.findMany({ where: { title: 'Safety report requires review', link: `/admin/reports?report=${report.id}` } });
    assert.deepEqual(admins.map(row => row.userId), [admin.id]);
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: work.id } })).status, 'DISPUTED');
  });
  await t.test('completion escalation alerts the seeker and active admin without duplicate receipts', async () => {
    const work = await booking('AWAITING_CONFIRMATION');
    await prisma.booking.update({ where: { id: work.id }, data: { updatedAt: new Date(Date.now() - 73 * 3600000) } });
    await createCompletionEscalation(work.id, provider.id, 'The completion is awaiting a response.');
    await createCompletionEscalation(work.id, provider.id, 'The completion is awaiting a response.');
    assert.equal(await prisma.notification.count({ where: { title: 'Completion review requested', userId: seeker.id, link: { contains: `booking=${work.id}` } } }), 1);
    const admins = await prisma.notification.findMany({ where: { title: 'Completion escalation requires review', link: `/admin/reports?booking=${work.id}` } });
    assert.deepEqual(admins.map(row => row.userId), [admin.id]);
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: work.id } })).status, 'AWAITING_CONFIRMATION');
  });
  await t.test('declined cancellation escalation saves an active admin alert once', async () => {
    const work = await booking();
    await prisma.booking.update({ where: { id: work.id }, data: { status: 'ONGOING', started: true } });
    await requestCancellation(work.id, seeker.id, 'The job cannot continue as planned.');
    const cancellation = await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: work.id } });
    await respondToCancellationRequest(cancellation.id, provider.id, false, 'Work is underway and needs review.');
    const escalated = await escalateCancellationRequest(cancellation.id, seeker.id);
    await escalateCancellationRequest(cancellation.id, seeker.id);
    const alerts = await prisma.notification.findMany({ where: { title: 'Cancellation escalation requires review', link: `/admin/reports?report=${escalated.reportId}` } });
    assert.deepEqual(alerts.map(row => row.userId), [admin.id]);
  });
  await t.test('review disputes persist and emit alerts for the author, admins and final participants', async () => {
    const completed = await prisma.completedService.findFirstOrThrow({ where: { seekerId: seeker.id, providerId: provider.id } });
    const review = await prisma.review.create({ data: { completedServiceId: completed.id, authorId: seeker.id, targetId: provider.id, rating: 3, text: 'Isolated review fixture.', editableUntil: new Date(Date.now() + 86400000) } });
    const invoke = async (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>, userId: string, body: object, id = '') => {
      let data: Record<string, any> = {};
      const res = { status: () => res, json: (value: Record<string, any>) => { data = value; } } as unknown as Response;
      await handler({ user: { id: userId }, body, params: { id } } as unknown as Request, res, error => { if (error) throw error; });
      return data;
    };
    emitted.length = 0;
    const submission = await invoke(submitTrustCase, provider.id, { reviewId: review.id, description: 'Please review this isolated review dispute.' });
    assert.ok(emitted.some(event => event.room === `user:${seeker.id}` && event.event === 'notification' && event.data.title === 'Review disputed'));
    const admins = await prisma.notification.findMany({ where: { title: 'Review or trust appeal requires review' } });
    assert.deepEqual(admins.map(row => row.userId), [admin.id]);
    emitted.length = 0;
    await invoke(decideTrustCase, admin.id, { uphold: false, reason: 'The isolated review does not violate the policy.' }, submission.data.id);
    const alerts = await prisma.notification.findMany({ where: { title: 'Review or trust appeal decided' } });
    assert.deepEqual(new Set(alerts.map(row => row.userId)), new Set([seeker.id, provider.id]));
    for (const member of [seeker, provider]) assert.ok(emitted.some(event => event.room === `user:${member.id}` && event.event === 'notification' && event.data.title === 'Review or trust appeal decided'));
  });
  await t.test('closing a public request notifies each provider with a pending offer',async()=>{
    const post=await request();await offer(post.id);await offer(post.id,secondProvider.id);await cancelRequest(post.id,seeker.id);
    const alerts=await prisma.notification.findMany({where:{title:'Request closed',id:{startsWith:`request-closed:${post.id}:`}}});
    assert.equal(alerts.length,2);assert.deepEqual(new Set(alerts.map(row=>row.userId)),new Set([provider.id,secondProvider.id]));
    assert.equal(await prisma.offer.count({where:{requestId:post.id,status:'REJECTED'}}),2);
  });
  await t.test('a removed listing warns its pending inquiry seeker without changing the inquiry workflow',async()=>{
    const listing=await prisma.service.create({data:{providerId:provider.id,categoryId:category.id,title:'Agreement fixture repair',titleNormalized:'agreement fixture repair',description:'Diagnosis and repair priced after review.',priceType:'BY_AGREEMENT',price:null,estimatedDurationMins:60,status:'ACTIVE',isAvailable:true,paymentMethods:{cash:true,gcash:false}}});
    const inquiry=await request({targetServiceId:listing.id,targetProviderId:provider.id});await deleteService(listing.id,provider.id);await deleteService(listing.id,provider.id);
    assert.equal(await prisma.notification.count({where:{id:`listing-removed:${listing.id}:${inquiry.id}`,userId:seeker.id}}),1);
    assert.equal((await prisma.serviceRequest.findUniqueOrThrow({where:{id:inquiry.id}})).status,'OPEN');
  });
  await t.test('one-alert reads are private and explicit mark-all respects its cutoff',async()=>{
    const selected=await prisma.notification.findFirstOrThrow({where:{userId:seeker.id,isRead:false}});
    const foreign=await prisma.notification.findFirstOrThrow({where:{userId:provider.id,isRead:false}});
    const invoke=async(handler:typeof markOneAsRead,id:string)=>{let status=200;let data:Record<string,any>={};const res={status:(value:number)=>{status=value;return res;},json:(value:Record<string,any>)=>{data=value;}} as unknown as Response;
      await handler({user:{id:seeker.id},params:{id}} as unknown as Request,res,error=>{if(error)throw error;});return {status,...data};};
    const before=await prisma.notification.count({where:{userId:seeker.id,isRead:false}});await invoke(markOneAsRead,selected.id);
    assert.equal(await prisma.notification.count({where:{userId:seeker.id,isRead:false}}),before-1);
    assert.equal((await invoke(markOneAsRead,foreign.id)).status,404);assert.equal((await prisma.notification.findUniqueOrThrow({where:{id:foreign.id}})).isRead,false);
    const arriving=await prisma.notification.create({data:{userId:seeker.id,title:'Arriving fixture alert',body:'Arrived after the read cutoff.',createdAt:new Date(Date.now()+60000)}});
    await invoke(markAllAsRead,'');assert.equal((await prisma.notification.findUniqueOrThrow({where:{id:arriving.id}})).isRead,false);
  });
});
