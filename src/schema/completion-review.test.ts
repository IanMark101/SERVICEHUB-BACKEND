import assert from 'node:assert/strict';
import test from 'node:test';
import { completionReviewAvailability } from '../services/bookings/completion-review';

const booking = {
  status: 'AWAITING_CONFIRMATION', paymentMethod: 'GCash', updatedAt: new Date('2026-10-16T10:00:00Z'),
  progressEvents: [{ kind: 'WORK_MARKED_COMPLETE', occurredAt: new Date('2026-10-12T10:00:00Z') }],
};

test('completion review uses recorded completion, unaffected by later booking edits', () => {
  assert.deepEqual(completionReviewAvailability(booking), {
    availableAt: '2026-10-15T10:00:00.000Z', pending: false,
  });
  assert.equal(completionReviewAvailability({ ...booking, updatedAt: new Date('2026-10-20T10:00:00Z') })?.availableAt,
    '2026-10-15T10:00:00.000Z');
});

test('repeated completion submissions use the latest recorded completion time', () => {
  assert.equal(completionReviewAvailability({ ...booking, progressEvents: [
    { kind: 'WORK_MARKED_COMPLETE', occurredAt: new Date('2026-10-14T12:00:00Z') },
    ...booking.progressEvents,
    { kind: 'CANCELLATION_DECLINED', occurredAt: new Date('2026-10-16T10:00:00Z') },
  ] })?.availableAt, '2026-10-17T12:00:00.000Z');
});

test('legacy completion records retain the previous updatedAt fallback', () => {
  assert.equal(completionReviewAvailability({ ...booking, progressEvents: [] })?.availableAt,
    '2026-10-19T10:00:00.000Z');
});

test('an admin KEEP_AWAITING decision enforces its own 72-hour retry cooldown', () => {
  assert.deepEqual(completionReviewAvailability(booking, {
    status: 'RESOLVED', resolution: 'KEEP_AWAITING', resolvedAt: new Date('2026-10-16T11:00:00Z'),
  }), { availableAt: '2026-10-19T11:00:00.000Z', pending: false });
});

test('pending and under-review cases are already requested; closed and non-awaiting bookings are not eligible', () => {
  for (const status of ['PENDING', 'UNDER_REVIEW']) {
    assert.equal(completionReviewAvailability(booking, { status, resolution: null, resolvedAt: null })?.pending, true);
  }
  for (const status of ['ONGOING', 'ACCEPTED', 'COMPLETED', 'CANCELED', 'DISPUTED', 'UNDER_REVIEW']) {
    assert.equal(completionReviewAvailability({ ...booking, status }), null);
  }
});

test('cash completion never offers routine admin review, even with a legacy case', () => {
  assert.equal(completionReviewAvailability({ ...booking, paymentMethod: 'On-site Cash' }, { status: 'PENDING', resolution: null, resolvedAt: null }), null);
});
