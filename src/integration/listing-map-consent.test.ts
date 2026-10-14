import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import express from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import servicesRoutes from '../routes/services.routes';
import locationsRoutes from '../routes/locations.routes';
import { nearbyRequests } from '../services/nearby.service';
import { NearbyQuerySchema } from '../schema/location.schema';

test('public map consent persists without disclosing private pins or directions, and reverse lookup stays bounded', {timeout:180000}, async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
  const tag=randomUUID(), ids:string[]=[];
  const createUser=async (name:string) => {
    const user=await prisma.user.create({ data:{ name, email:`${name}-${tag}@example.test`, phone:`fixture-${name}-${tag}`, location:'Cordova', passwordHash:'fixture', emailVerified:true, verificationStatus:'APPROVED' } });
    ids.push(user.id); return user;
  };
  const [owner, peer]=await Promise.all([createUser('Owner'),createUser('Peer')]);
  const category=await prisma.category.create({ data:{ name:`Computer repairs ${tag}` } });
  const tokenFor=async (user:typeof owner) => {
    const session=await prisma.refreshToken.create({ data:{ userId:user.id,token:randomUUID(),expiresAt:new Date(Date.now()+300000) } });
    return jwt.sign({ sub:user.id,role:'user',sid:session.id },env.JWT_ACCESS_SECRET,{expiresIn:'5m'});
  };
  const ownerToken=await tokenFor(owner), peerToken=await tokenFor(peer);
  const app=express(); app.use(express.json()); app.use('/api/services',servicesRoutes); app.use('/api/locations',locationsRoutes);
  app.use((error:any,_req:any,res:any,_next:any) => res.status(error.name==='ZodError' ? 400 : error.status || 500).json({ error:error.message }));
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve));
  const port=(server.address() as {port:number}).port;
  const nativeFetch=globalThis.fetch;
  const upstream:string[]=[];
  globalThis.fetch=(async (input:Parameters<typeof fetch>[0], init?:Parameters<typeof fetch>[1]) => {
    const url=new URL(String(input));
    if (url.hostname==='127.0.0.1') return nativeFetch(input,init);
    upstream.push(url.toString());
    return new Response(JSON.stringify({ address:{ suburb:'Gabi',municipality:'Cordova',province:'Cebu',road:'PRIVATE STREET',house_number:'42' } }),{status:200,headers:{'Content-Type':'application/json'}});
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch=nativeFetch;
    server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
    await prisma.serviceRequest.deleteMany({where:{seekerId:{in:ids}}});
    await prisma.service.deleteMany({where:{providerId:{in:ids}}});
    await prisma.user.deleteMany({where:{id:{in:ids}}});
    await prisma.category.delete({where:{id:category.id}}); await prisma.$disconnect();
  });
  const call=async (path:string, token?:string, method='GET',body?:unknown) => {
    const response=await fetch(`http://127.0.0.1:${port}/api${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)} : {})});
    return {status:response.status,body:await response.json() as any};
  };
  const pin={latitude:10.312345,longitude:123.934567,label:'Gabi, Cordova, Cebu'};
  const payload={categoryId:category.id,title:'LAPTOP REPAIR SERVICE',description:'I diagnose and repair laptop hardware at your location or my workshop.',price:500,serviceLocation:pin,serviceLocationMode:'BOTH',venueAddress:'PRIVATE WORKSHOP DIRECTIONS',coverageRadiusKm:10,estimatedDurationMins:60,paymentMethods:{cash:true,gcash:true}};
  const created=await call('/services',ownerToken,'POST',payload);
  assert.equal(created.status,201,JSON.stringify(created.body));
  const id=created.body.data.id;
  const nearbyPath=`/services/nearby?latitude=${pin.latitude}&longitude=${pin.longitude}&radiusKm=10`;
  const mapPin=async () => (await call(nearbyPath)).body.data.mapPins.find((item:any)=>item.id===id);

  await t.test('default and opted-out pins are approximate; only the owner can publish an exact pin',async()=>{
    assert.equal(created.body.data.publicMapPin,false);
    assert.deepEqual((await mapPin()).area,{latitude:10.31,longitude:123.93,approximate:true});
    const unauthorized=await call(`/services/${id}`,peerToken,'PATCH',{publicMapPin:true});
    assert.equal(unauthorized.status,404);
    assert.equal((await call(`/services/${id}`,ownerToken,'PATCH',{publicMapPin:true})).status,200);
    assert.deepEqual((await mapPin()).area,{latitude:pin.latitude,longitude:pin.longitude,approximate:false});
    const publicData=(await call(nearbyPath)).body.data;
    assert.equal('latitude' in publicData.items[0],false);
    assert.equal(JSON.stringify(publicData).includes('PRIVATE WORKSHOP DIRECTIONS'),false);
    const own=(await call('/services/mine',ownerToken)).body.data.find((item:any)=>item.id===id);
    assert.equal(own.latitude,pin.latitude); assert.equal(own.publicMapPin,true);
    assert.equal((await call(`/services/${id}`,ownerToken,'PATCH',{publicMapPin:false})).status,200);
    assert.equal((await mapPin()).area.approximate,true);
  });
  await t.test('moving a pin without renewed consent restores privacy; request/job pins remain approximate',async()=>{
    await call(`/services/${id}`,ownerToken,'PATCH',{publicMapPin:true});
    const moved={...pin,latitude:10.313456,longitude:123.935678};
    assert.equal((await call(`/services/${id}`,ownerToken,'PATCH',{serviceLocation:moved})).status,200);
    assert.equal((await prisma.service.findUniqueOrThrow({where:{id}})).publicMapPin,false);
    await prisma.serviceRequest.create({data:{seekerId:peer.id,categoryId:category.id,title:'Laptop repair request',description:'Please repair my broken laptop charging port.',budgetMin:500,budgetMax:1000,urgency:'This Week',latitude:pin.latitude,longitude:pin.longitude,locationLabel:pin.label,privateAddress:'PRIVATE JOB DIRECTIONS',paymentMethods:{cash:true,gcash:false}}});
    const requests=await nearbyRequests(NearbyQuerySchema.parse({latitude:pin.latitude,longitude:pin.longitude,radiusKm:10}),owner.id);
    assert.equal(requests.mapPins[0].area?.approximate,true);
    assert.equal(JSON.stringify(requests).includes('PRIVATE JOB DIRECTIONS'),false);
  });
  await t.test('reverse lookup requires authentication, validates coordinates and caches locality-only results',async()=>{
    const path=`/locations/reverse?latitude=${pin.latitude}&longitude=${pin.longitude}`;
    assert.equal((await call(path)).status,401);
    assert.equal((await call('/locations/reverse?latitude=91&longitude=123',ownerToken)).status,400);
    const first=await call(path,ownerToken);
    assert.equal(first.status,200); assert.deepEqual(first.body.data,{label:'Gabi, Cordova, Cebu'});
    assert.equal(upstream.length,1); assert.equal(new URL(upstream[0]).searchParams.get('zoom'),'14');
    assert.equal(new URL(upstream[0]).searchParams.get('lat'),String(pin.latitude));
    assert.equal(JSON.stringify(first.body).includes('PRIVATE STREET'),false);
    await call(path,ownerToken); assert.equal(upstream.length,1);
  });
});
