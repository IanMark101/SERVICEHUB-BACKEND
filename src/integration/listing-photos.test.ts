import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import cloudinary from '../config/cloudinary';
import { createService, updateService, getServiceById, getMyServices } from '../services/services.service';
import { createRequest, updateRequest, listRequests, getMyRequests } from '../services/requests.service';
import { setListingPhotos, deleteUnusedListingPhoto, pruneUnusedListingPhotos } from '../services/listing-photos.service';
import { CreateServiceSchema } from '../schema/services.schema';

assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
after(() => prisma.$disconnect());

test('listing photos persist in cover order for both roles, enforce ownership and support editing', async t => {
  const suffix = randomUUID();
  const owner = await prisma.user.create({ data: { gcashNumber: '09123456789', name: 'Photo listing sample', email: `photos-${suffix}@example.test`, passwordHash: 'unused-test-hash', phone: '', location: 'Cordova', verificationStatus: 'APPROVED', emailVerified: true } });
  const other = await prisma.user.create({ data: { gcashNumber: '09123456789', name: 'Other photo sample', email: `other-photos-${suffix}@example.test`, passwordHash: 'unused-test-hash', phone: '', location: 'Cordova', verificationStatus: 'APPROVED', emailVerified: true } });
  const category = await prisma.category.create({ data: { name: `Electrical Repair ${suffix}` } });
  const photos = await Promise.all(Array.from({ length: 4 }, (_, index) => prisma.listingPhoto.create({ data: { ownerId: owner.id, publicId: `fixture/${suffix}/${index}`, url: `https://res.cloudinary.com/fixture/image/upload/${suffix}-${index}.jpg`, width: 1200, height: 800 } })));
  const location = { latitude: 10.26, longitude: 123.95, label: 'Cordova' };
  const input = CreateServiceSchema.parse({ categoryId: category.id, title: 'LAPTOP REPAIR WITH PHOTOS', description: 'Laptop diagnostics and repair. Replacement parts are quoted separately.', price: 500, estimatedDurationMins: 60, paymentMethods: { cash: true }, serviceLocation: location, coverageRadiusKm: 10, photoIds: photos.slice(0, 3).map(photo => photo.id) });
  const service = await createService(owner.id, input);
  assert.deepEqual(service.photos.map(photo => photo.id), photos.slice(0, 3).map(photo => photo.id));
  assert.ok(!JSON.stringify(service.photos).includes('publicId'));
  assert.deepEqual((await getServiceById(service.id)).photos.map(photo => photo.id), service.photos.map(photo => photo.id));
  assert.equal((await getMyServices(owner.id)).find(item => item.id === service.id)?.photos.length, 3);
  await assert.rejects(prisma.$transaction(tx => setListingPhotos(tx, other.id, [photos[0].id], { serviceId: service.id })), /own listing/);
  assert.equal(await prisma.serviceListingPhoto.count({ where: { serviceId: service.id } }), 3);
  await assert.rejects(prisma.serviceListingPhoto.create({ data: { serviceId: service.id, photoId: photos[3].id, position: 3 } }));
  const updated = await updateService(service.id, owner.id, { photoIds: [photos[2].id, photos[0].id] });
  assert.deepEqual(updated.photos.map(photo => photo.id), [photos[2].id, photos[0].id]);
  for (const count of [1, 2, 3]) {
    const request = await createRequest(owner.id, { categoryId: category.id, title: `LAPTOP REPAIR REQUEST ${count}`, description: 'My laptop will not turn on and needs repair.', urgency: 'This Week', budgetMin: 500, budgetMax: 500, paymentMethods: { cash: true, gcash: false }, jobLocation: location, photoIds: photos.slice(0, count).map(photo => photo.id) });
    assert.equal(request.photos.length, count);
    assert.equal((await listRequests(category.id, other.id)).find(item => item.id === request.id)?.photos.length, count);
    assert.equal((await getMyRequests(owner.id)).find(item => item.id === request.id)?.photos.length, count);
    const cleared = await updateRequest(request.id, owner.id, { photoIds: [] });
    assert.deepEqual(cleared.photos, []);
  }
  t.mock.method(cloudinary.uploader, 'destroy', async () => ({ result: 'ok' }));
  await assert.rejects(deleteUnusedListingPhoto(other.id, photos[3].id), /unavailable/);
  await assert.rejects(deleteUnusedListingPhoto(owner.id, photos[0].id), /already saved/);
  await deleteUnusedListingPhoto(owner.id, photos[3].id);
  assert.equal(await prisma.listingPhoto.findUnique({ where: { id: photos[3].id } }), null);
  await prisma.listingPhoto.updateMany({ where: { ownerId: owner.id }, data: { createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000) } });
  await pruneUnusedListingPhotos();
  assert.equal(await prisma.listingPhoto.count({ where: { ownerId: owner.id } }), 2, 'saved photos survive cleanup, abandoned uploads expire');
  await prisma.user.delete({ where: { id: owner.id } });
  await pruneUnusedListingPhotos();
  assert.equal(await prisma.listingPhoto.count({ where: { publicId: { startsWith: `fixture/${suffix}` } } }), 0, 'account-purge images are removed from storage and the database');
});
