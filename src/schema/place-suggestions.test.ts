import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaceSuggestionQuerySchema } from './location.schema';
import { createPlaceSuggester } from '../services/place-suggestions.service';

const feature = (name: string, extra: Record<string, unknown> = {}) => ({ type:'Feature', geometry:{type:'Point',coordinates:[123.95,10.25]}, properties:{name,state:'Cebu',countrycode:'PH',...extra} });
const response = (features = [feature('Cordova')]) => new Response(JSON.stringify({features}), { status:200, headers:{'Content-Type':'application/json'} });

test('place-suggestion queries validate partial names and paired coordinates', () => {
  assert.deepEqual(PlaceSuggestionQuerySchema.parse({q:' cordov '}),{q:'cordov'});
  assert.deepEqual(PlaceSuggestionQuerySchema.parse({q:' c '}),{q:'c'});
  for (const value of [{q:' '},{q:'x'.repeat(81)},{q:'cordov',latitude:10},{q:'cordov',latitude:91,longitude:123},{q:'cordov',url:'https://example.test'}]) assert.equal(PlaceSuggestionQuerySchema.safeParse(value).success,false);
});

test('partial names use worldwide Photon layers and coarse map bias, never private addresses', async () => {
  let called!: URL;
  const fetcher: typeof fetch = async url => { called = new URL(String(url)); return response([feature('Cordova',{city:'Cordova',street:'Private street',housenumber:'12'})]); };
  const suggest = createPlaceSuggester({fetcher});
  assert.deepEqual(await suggest({q:'cordov',latitude:10.25219,longitude:123.94947}),[{latitude:10.25,longitude:123.95,label:'Cordova, Cebu'}]);
  assert.equal(called.hostname,'photon.komoot.io'); assert.equal(called.searchParams.get('q'),'cordov');
  assert.equal(called.searchParams.has('countrycode'),false); assert.equal(called.searchParams.get('lat'),'10.25'); assert.equal(called.searchParams.get('lon'),'123.95');
  assert.deepEqual(called.searchParams.getAll('layer'),['country','locality','district','city','county','state']);
});

test('deduplicates results and rejects malformed and non-point records', async () => {
  const suggest = createPlaceSuggester({fetcher:async()=>response([feature('Cordova'),feature('Cordova'),{...feature('Broken'),geometry:{type:'Point',coordinates:[123.95,NaN]}},{...feature('Area'),geometry:{type:'Polygon',coordinates:[]}}])});
  assert.deepEqual(await suggest({q:'cordov'}),[{latitude:10.25,longitude:123.95,label:'Cordova, Cebu'}]);
});

test('first-letter suggestions contain matching countries without a local map bias', async () => {
  let called!: URL;
  const suggest=createPlaceSuggester({fetcher:async url=>{called=new URL(String(url));return response([
    feature('Canada',{country:'Canada',countrycode:'CA',state:undefined}),
    feature('China',{country:'China',countrycode:'CN',state:undefined}),
    feature('France',{country:'France',countrycode:'FR',state:undefined}),
  ]);}});
  assert.deepEqual((await suggest({q:'c',latitude:10.25,longitude:123.95})).map(p=>p.label),['Canada','China']);
  assert.deepEqual(called.searchParams.getAll('layer'),['country']);
  assert.equal(called.searchParams.has('lat'),false);assert.equal(called.searchParams.has('lon'),false);
});

test('worldwide places include country names to distinguish matching localities', async () => {
  const suggest=createPlaceSuggester({fetcher:async()=>response([
    feature('Cordova',{country:'Philippines'}),
    {...feature('Cordova',{country:'United States',countrycode:'US',state:'Alaska'}),geometry:{type:'Point',coordinates:[-145.76,60.54]}},
  ])});
  assert.deepEqual(await suggest({q:'cordov'}),[
    {latitude:10.25,longitude:123.95,label:'Cordova, Cebu, Philippines'},
    {latitude:60.54,longitude:-145.76,label:'Cordova, Alaska, United States'},
  ]);
});

test('coalesces identical in-flight queries and serves cached prefixes without upstream traffic', async () => {
  let finish!: (value: Response)=>void; let calls=0;
  const suggest=createPlaceSuggester({fetcher:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  const first=suggest({q:'Cordov'}), second=suggest({q:'cordov'});
  assert.equal(calls,1); finish(response());
  assert.deepEqual(await first,await second); await suggest({q:'CORDOV'}); assert.equal(calls,1);
});

test('bounds different upstream requests instead of building a global autocomplete queue', async () => {
  const finish:Array<(value:Response)=>void>=[];
  const suggest=createPlaceSuggester({fetcher:()=>new Promise(resolve=>finish.push(resolve))});
  const requests=['cordov','mandaue','lapu','talisay'].map(q=>suggest({q}));
  await assert.rejects(suggest({q:'cebu'}),{status:429}); assert.equal(finish.length,4);
  finish.forEach(resolve=>resolve(response())); await Promise.all(requests);
});

test('briefly backs off after failure while preserving cached results and allowing recovery', async () => {
  let time=10000, calls=0;
  const suggest=createPlaceSuggester({now:()=>time,fetcher:async()=>{calls++; if(calls===2)throw new Error('Offline');return response();}});
  await suggest({q:'cordov'}); await assert.rejects(suggest({q:'cebu'}),{status:503});
  await assert.rejects(suggest({q:'mandaue'}),{status:503}); assert.equal(calls,2);
  assert.equal((await suggest({q:'cordov'})).length,1); time+=5001;
  await suggest({q:'cebu'}); assert.equal(calls,3);
});

test('never allows public Nominatim to be configured as the autocomplete upstream', async () => {
  let called=false;
  const suggest=createPlaceSuggester({endpoint:()=> 'https://nominatim.openstreetmap.org/search',fetcher:async()=>{called=true;return response();}});
  await assert.rejects(suggest({q:'cordov'}),{status:503}); assert.equal(called,false);
});
