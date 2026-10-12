import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { NearbyQuerySchema } from './location.schema';
import { publicMapArea } from '../lib/proximity';

test('public map areas use a fixed coarse grid and contain no private address',()=>{
  const point={latitude:10.30573,longitude:123.91426,privateAddress:'Private directions'};
  assert.deepEqual(publicMapArea(point),{latitude:10.31,longitude:123.91,approximate:true});
  assert.equal(publicMapArea({latitude:null,longitude:123}),null);
});

test('both nearby maps share exact radius, filters and eligibility queries with the list before paging',async t=>{
  const singleton=globalThis as unknown as {prisma?:PrismaClient};
  const previous=singleton.prisma;
  const make=(id:string,latitude:number,extra:Record<string,unknown>={})=>({
    id,title:`Work ${id}`,latitude,longitude:123.9,locationLabel:'Cordova',privateAddress:'Private directions',
    providerId:'provider',provider:{id:'provider',trustScore:50},seekerId:'seeker',seeker:{id:'seeker'},
    budgetMax:600,urgency:'ASAP / Today',_count:{offers:0},createdAt:new Date(),...extra,
  });
  const records=[make('near',10.3005),make('next-page',10.303),make('edge',10.304),make('far',10.4),make('unknown',NaN,{latitude:null})];
  const serviceFind=t.mock.fn(async(_query:unknown)=>records);
  const requestFind=t.mock.fn(async(_query:unknown)=>records);
  singleton.prisma={
    service:{findMany:serviceFind},serviceRequest:{findMany:requestFind},
    review:{findMany:async()=>[]},user:{findMany:async()=>[{id:'provider',onlineQueueLimit:5}]},queue:{findMany:async()=>[]},$queryRaw:async()=>[],
  } as unknown as PrismaClient;
  t.after(()=>{singleton.prisma=previous;});
  const {nearbyServices,nearbyRequests}=await import('../services/nearby.service');
  const query=NearbyQuerySchema.parse({latitude:10.3,longitude:123.9,radiusKm:.5,limit:1,search:'Work',category:'Plumbing'});
  for(const load of [nearbyServices,(query:Parameters<typeof nearbyRequests>[0])=>nearbyRequests(query,'provider')]) {
    const first=await load(query);
    assert.equal(first.items.length,1);assert.equal(first.pagination.total,3);
    assert.deepEqual(first.mapPins.map(pin=>pin.id),['near','next-page','edge']);
    for(const pin of first.mapPins) {
      assert.equal(pin.area?.approximate,true);
      assert.deepEqual(Object.keys(pin).sort(),['area','id','label','title']);
      assert.equal('privateAddress' in pin,false);
    }
    assert.equal('latitude' in first.items[0],false);assert.equal('privateAddress' in first.items[0],false);
    assert.deepEqual((await load({...query,page:2})).mapPins,first.mapPins);
    const wider=await load({...query,radiusKm:30});
    assert.ok(wider.mapPins.some(pin=>pin.id==='far'));
    const narrowed=await load({...query,latitude:11});
    assert.deepEqual(narrowed.mapPins,[]);
  }
  assert.deepEqual((await nearbyServices({...query,filter:'rated'})).mapPins,[]);
  assert.deepEqual((await nearbyRequests({...query,filter:'high-budget'},'provider')).mapPins.map(pin=>pin.id),['near','next-page','edge']);
  for(const mock of [serviceFind,requestFind]) {
    const args=mock.mock.calls[0].arguments[0] as {where:Record<string,unknown>};
    assert.ok(args.where.AND,'Search and bounds stay on the database query');
    assert.ok(args.where.category,'Category stays on the database query');
    assert.ok(args.where.provider || args.where.seeker,'Account eligibility stays on the database query');
  }
});
