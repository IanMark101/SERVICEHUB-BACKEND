import assert from 'node:assert/strict';
import test from 'node:test';
import type { BookingStatus, OfferStatus, PaymentAttemptStatus, RequestStatus } from '@prisma/client';
import { requestDeletionEligibility } from '../lib/request-deletion';

test('request deletion uses actual lifecycle states and keeps all booked history', () => {
  assert.equal(requestDeletionEligibility({ status: 'OPEN', offers: [{ status: 'PENDING' }] }).canDelete, true);
  for (const status of ['PAYMENT_PENDING', 'IN_PROGRESS', 'CLOSED', 'CANCELED'] as RequestStatus[]) {
    assert.equal(requestDeletionEligibility({ status, offers: [] }).canDelete, false);
  }
  for (const status of ['ACCEPTED', 'PENDING_PAYMENT'] as OfferStatus[]) {
    assert.equal(requestDeletionEligibility({ status: 'OPEN', offers: [{ status }] }).canDelete, false);
  }
  for (const status of ['PENDING_APPROVAL', 'WAITING', 'ONGOING', 'ACCEPTED', 'AWAITING_CONFIRMATION', 'UNDER_REVIEW', 'DISPUTED', 'COMPLETED'] as BookingStatus[]) {
    assert.equal(requestDeletionEligibility({ status: 'OPEN', offers: [{ status: 'REJECTED', booking: { status } }] }).canDelete, false);
  }
  for (const status of ['PENDING', 'SUCCEEDED', 'REFUND_REQUIRED'] as PaymentAttemptStatus[]) {
    assert.equal(requestDeletionEligibility({ status: 'OPEN', offers: [] }, [{ status }]).canDelete, false);
  }
  for (const status of ['FAILED', 'EXPIRED', 'REFUNDED'] as PaymentAttemptStatus[]) {
    assert.equal(requestDeletionEligibility({ status: 'OPEN', offers: [] }, [{ status }]).canDelete, true);
  }
  for (const status of ['DECLINED', 'CANCELED', 'REMOVED'] as BookingStatus[]) {
    assert.equal(requestDeletionEligibility({ status: 'OPEN', offers: [{ status: 'REJECTED', booking: { status } }] }).canDelete, true);
  }
});
