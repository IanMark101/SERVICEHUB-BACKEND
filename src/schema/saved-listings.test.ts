import assert from 'node:assert/strict';
import test from 'node:test';
import { SavedListingParamsSchema, SavedListingsQuerySchema, SavedListingStatusSchema } from './saved-listings.schema';

test('Saved validates target type, bounded pagination and bounded status batches', () => {
  assert.equal(SavedListingsQuerySchema.parse({ contentType: 'SERVICE_LISTING' }).limit, 12);
  assert.equal(SavedListingsQuerySchema.safeParse({ contentType: 'SERVICE_REQUEST', limit: 31 }).success, false);
  assert.equal(SavedListingParamsSchema.safeParse({ contentType: 'USER', listingId: 'x' }).success, false);
  assert.equal(SavedListingParamsSchema.safeParse({ contentType: 'SERVICE_LISTING', listingId: '' }).success, false);
  assert.deepEqual(SavedListingStatusSchema.parse({ contentType: 'SERVICE_REQUEST', ids: 'one,one,two' }).ids, ['one', 'two']);
  assert.equal(SavedListingStatusSchema.safeParse({ contentType: 'SERVICE_REQUEST', ids: Array.from({ length: 101 }, (_, i) => String(i)).join(',') }).success, false);
});
