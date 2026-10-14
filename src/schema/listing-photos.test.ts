import assert from 'node:assert/strict';
import test from 'node:test';
import { ListingPhotoIdsSchema, validateListingPhotoImage } from './listing-photos.schema';

const ids = ['cmuznda9i000024jv8yl794nm', 'cmuzk8afp000004jvbxzjxhiv', 'cmuznda9i000124jv8yl794nm', 'cmuznda9i000224jv8yl794nm'];
test('listing photo IDs allow zero through three unique uploads and reject external URLs', () => {
  for (let count = 0; count <= 3; count++) assert.equal(ListingPhotoIdsSchema.safeParse(ids.slice(0, count)).success, true);
  for (const invalid of [ids, [ids[0], ids[0]], ['https://example.com/photo.jpg'], ['invalid']]) assert.equal(ListingPhotoIdsSchema.safeParse(invalid).success, false);
});
test('listing uploads reject disguised files and enforce the actual image size', () => {
  const jpeg = Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1]);
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  assert.ok(validateListingPhotoImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`));
  assert.ok(validateListingPhotoImage(`data:image/png;base64,${png.toString('base64')}`));
  for (const invalid of [null, 'https://example.com/image.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${jpeg.toString('base64')}`, `data:image/jpeg;base64,${Buffer.from('not an image file').toString('base64')}`, `data:image/jpeg;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')}`]) assert.equal(validateListingPhotoImage(invalid), null);
});
