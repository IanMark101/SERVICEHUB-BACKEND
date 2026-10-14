import assert from 'node:assert/strict';
import test from 'node:test';
import { localityLabel } from '../lib/place-label';
import { publicMapArea, publicLocation } from '../lib/proximity';
import { CreateServiceSchema, UpdateServiceSchema } from './services.schema';

test('exact public coordinates require explicit listing consent; private projections stay private', () => {
  const pin={ latitude:10.312345, longitude:123.934567 };
  assert.deepEqual(publicMapArea(pin), { latitude:10.31, longitude:123.93, approximate:true });
  assert.deepEqual(publicMapArea(pin, true), { ...pin, approximate:false });
  const projected=publicLocation({ ...pin, publicMapPin:true, venueAddress:'PRIVATE DIRECTIONS', privateAddress:'PRIVATE JOB' });
  assert.equal('latitude' in projected, false); assert.equal('longitude' in projected, false);
  assert.equal('venueAddress' in projected, false); assert.equal('privateAddress' in projected, false);
  assert.equal(UpdateServiceSchema.parse({ publicMapPin:false }).publicMapPin, false);
  assert.equal(UpdateServiceSchema.safeParse({ publicMapPin:'true' }).success, false);
  const input=CreateServiceSchema.parse({ categoryId:'category', title:'Laptop repair service', description:'I diagnose and repair computer hardware safely.', price:500, serviceLocation:{...pin,label:'Cordova'}, estimatedDurationMins:60, paymentMethods:{cash:true} });
  assert.equal(input.publicMapPin, false);
});

test('reverse lookup extracts only a general locality and omits street, house and business details', () => {
  assert.equal(localityLabel({ suburb:'Gabi', municipality:'Cordova', province:'Cebu', state:'Central Visayas', road:'Private Street', house_number:'42', shop:'Private workshop' }), 'Gabi, Cordova, Cebu');
  assert.equal(localityLabel({ village:'Cordova', town:'Cordova', state:'Cebu' }), 'Cordova, Cebu');
  assert.equal(localityLabel({ house_number:'42', road:'Private Street', state:'Cebu' }), null);
  assert.equal(localityLabel(null), null); assert.equal(localityLabel([]), null);
});
