import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { assertListingGCashNumber } from '../services/gcash-listing-policy';

test('GCash listings require the owner’s valid saved number; Cash-only needs no wallet lookup', async () => {
  let reads = 0;
  let number: string | null = null;
  const tx = { user: { findUnique: async (query: { where: { id: string } }) => { reads++; assert.equal(query.where.id, 'owner'); return { gcashNumber: number }; } } } as unknown as Prisma.TransactionClient;
  await assertListingGCashNumber(tx, 'owner', { cash: true, gcash: false });
  assert.equal(reads, 0);
  for (number of [null, '', 'invalid', '0912345678']) {
    await assert.rejects(assertListingGCashNumber(tx, 'owner', { cash: true, gcash: true }), { status: 422, code: 'GCASH_NUMBER_REQUIRED', field: 'gcashNumber' });
  }
  number = '09123456789';
  await assert.doesNotReject(assertListingGCashNumber(tx, 'owner', { cash: false, gcash: true }));
});
