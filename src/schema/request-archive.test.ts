import assert from 'node:assert/strict';
import test from 'node:test';
import type { BookingStatus } from '@prisma/client';
import { canArchiveCompletedRequest } from '../lib/request-archive';

test('archiving requires completed work and excludes all live booking/payment states', () => {
  const completed = { status: 'ACCEPTED' as const, booking: { status: 'COMPLETED' as const } };
  assert.equal(canArchiveCompletedRequest([completed]), true);
  assert.equal(canArchiveCompletedRequest([]), false);
  assert.equal(canArchiveCompletedRequest([{ status: 'PENDING' }]), false);
  assert.equal(canArchiveCompletedRequest([completed, { status: 'PENDING_PAYMENT' }]), false);
  for (const status of ['PENDING_APPROVAL', 'WAITING', 'ONGOING', 'ACCEPTED', 'AWAITING_CONFIRMATION', 'UNDER_REVIEW', 'DISPUTED'] as BookingStatus[]) {
    assert.equal(canArchiveCompletedRequest([completed, { status: 'ACCEPTED', booking: { status } }]), false);
  }
  for (const status of ['DECLINED', 'CANCELED', 'REMOVED'] as BookingStatus[]) {
    assert.equal(canArchiveCompletedRequest([completed, { status: 'REJECTED', booking: { status } }]), true);
  }
});
