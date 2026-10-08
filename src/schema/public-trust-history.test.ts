import assert from 'node:assert/strict';
import test from 'node:test';
import { toPublicTrustEvent } from '../lib/public-trust-history';

const event = { id: 'event', userId: 'private-user', actorAdminId: 'private-admin', requestedDelta: -99,
  eventKey: 'manual-trust:private-admin:operation', delta: -5, reason: 'Internal note containing private evidence',
  scoreBefore: 55, scoreAfter: 50, createdAt: new Date('2026-10-07T05:00:00Z') };

test('public trust history exposes score changes without raw notes or internal identifiers', () => {
  assert.deepEqual(toPublicTrustEvent(event), { id: 'event', delta: -5, reason: 'Trust score adjusted by administrator',
    scoreBefore: 55, scoreAfter: 50, createdAt: event.createdAt });
});

test('every event remains visible, including legacy events and zero actual deltas', () => {
  for (const eventKey of [null, 'unknown-event:private-id', 'report:private-report:penalty']) {
    const safe = toPublicTrustEvent({ ...event, delta: 0, scoreAfter: 55, eventKey });
    assert.equal(safe.delta, 0);
    assert.equal(safe.id, event.id);
    assert.ok(!JSON.stringify(safe).includes('private'));
  }
});

test('recognized milestones and review changes get useful public labels', () => {
  for (const [eventKey, reason, expected] of [
    ['account-baseline:user', 'private', 'Account created: starting trust score'],
    ['verification-approval:user', 'private', 'Residency and identity verified'],
    ['booking-completion:booking', 'private', 'Service completed and confirmed'],
    ['review:review', 'Received 5-star seeker review', 'Received a 5-star seeker review'],
    ['review:review:updated', 'Review rating updated from 2 to 4', 'Review rating updated from 2 to 4'],
    ['review:review:hidden', 'Review hidden by administrator', 'Review removed from trust calculation'],
    ['cancellation:private-id', 'private', 'At-fault booking cancellation'],
  ]) assert.equal(toPublicTrustEvent({ ...event, eventKey, reason }).reason, expected);
});
