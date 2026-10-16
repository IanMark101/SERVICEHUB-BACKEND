import assert from 'node:assert/strict';
import test from 'node:test';
import { awardBookingCompletionTrust, TRUST_PAIR_WINDOW_DAYS } from '../services/trust-policy.service';

const DAY = 86400000;
const NOW = Date.parse('2026-10-17T09:00:00Z');

function fixture(previous: { age: number; providerId: string; seekerId: string; delta?: number } | null, swapped = false) {
  const providerId = swapped ? 'ben' : 'ana';
  const seekerId = swapped ? 'ana' : 'ben';
  const scores = new Map([['ana', 55], ['ben', 55]]);
  const events: Array<Record<string, any>> = [];
  const account = { verificationStatus: 'APPROVED', isActive: true, moderationStatus: 'ACTIVE' };
  let cutoff: Date | undefined;
  const tx = {
    $queryRaw: async () => [],
    booking: { findUnique: async () => ({ id: 'current', providerId, seekerId, status: 'COMPLETED',
      paymentStatus: 'CASH_CONFIRMED', completedService: { id: 'completed' }, provider: account, seeker: account }) },
    report: { count: async () => 0 }, cancellationRequest: { count: async () => 0 }, completionEscalation: { count: async () => 0 },
    user: {
      findUnique: async ({ where }: any) => ({ trustScore: scores.get(where.id) }),
      update: async ({ where, data }: any) => { scores.set(where.id, data.trustScore); return data; },
    },
    trustScoreEvent: {
      findFirst: async ({ where }: any) => {
        if (where.category !== 'COMPLETION') return null;
        cutoff = where.createdAt.gt;
        const samePair = previous && where.booking.OR.some((pair: any) => pair.providerId === previous.providerId && pair.seekerId === previous.seekerId);
        return previous && samePair && NOW - previous.age > cutoff!.getTime() ? { id: 'previous', delta: previous.delta ?? 3 } : null;
      },
      findUnique: async ({ where }: any) => events.find(event => event.eventKey === where.eventKey) ?? null,
      create: async ({ data }: any) => { events.push(data); return data; },
    },
  };
  return { tx, scores, events, cutoff: () => cutoff };
}

test('trust rewards use a seven-day rolling window with an inclusive release boundary', async t => {
  t.mock.method(Date, 'now', () => NOW);
  assert.equal(TRUST_PAIR_WINDOW_DAYS, 7);
  for (const [label, age, expected] of [
    ['one millisecond before seven full days', 7 * DAY - 1, 0],
    ['exactly seven full days', 7 * DAY, 2],
    ['eight days, rather than waiting thirty', 8 * DAY, 2],
  ] as const) {
    const f = fixture({ age, providerId: 'ana', seekerId: 'ben' });
    await awardBookingCompletionTrust(f.tx as never, 'current');
    assert.equal(f.cutoff()?.getTime(), NOW - 7 * DAY, label);
    assert.equal(f.events.length, expected, label);
    assert.equal(f.scores.get('ana'), expected ? 58 : 55, label);
    assert.equal(f.scores.get('ben'), expected ? 58 : 55, label);
  }
});

test('swapping workspaces does not bypass the weekly limit, including a previously clamped award', async t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const delta of [3, 0]) {
    const f = fixture({ age: 6 * DAY, providerId: 'ana', seekerId: 'ben', delta }, true);
    await awardBookingCompletionTrust(f.tx as never, 'current');
    assert.equal(f.events.length, 0);
  }
});

test('another account pair can earn points independently and retries do not duplicate the reward', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const f = fixture({ age: DAY, providerId: 'ana', seekerId: 'carlo' });
  await awardBookingCompletionTrust(f.tx as never, 'current');
  await awardBookingCompletionTrust(f.tx as never, 'current');
  assert.equal(f.events.length, 2);
  assert.equal(f.scores.get('ana'), 58);
  assert.equal(f.scores.get('ben'), 58);
});
