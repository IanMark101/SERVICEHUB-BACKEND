import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { submitTrustCase, decideTrustCase, respondToTrustCase } from '../controllers/trust-cases.controller';

test('policy transition and review response safeguards in a disposable schema', async t => {
  const schema = new URL(env.DATABASE_URL).searchParams.get('schema') || '';
  assert.match(schema, /^servicehub_migration_test_[a-f0-9]{32}$/);
  t.after(() => prisma.$disconnect());
  const tag = randomUUID(); let sequence = 0;
  const user = (role = 'user', trustScore = 50) => prisma.user.create({ data: { name: 'Policy security test', email: `policy-sec-${tag}-${sequence++}@example.test`, passwordHash: 'no-login', phone: '', location: 'Cordova', role, trustScore } });
  const [recipient, author, admin] = await Promise.all([user(), user(), user('admin')]);
  const booking = await prisma.booking.create({ data: { providerId: recipient.id, seekerId: author.id, status: 'COMPLETED', paymentStatus: 'CASH_CONFIRMED', paymentMethod: 'On-site Cash', agreedAmount: 500 } });
  const service = await prisma.completedService.create({ data: { bookingId: booking.id, providerId: recipient.id, seekerId: author.id, finalPrice: 500, paymentStatus: 'CASH_CONFIRMED' } });
  const review = await prisma.review.create({ data: { authorId: author.id, targetId: recipient.id, completedServiceId: service.id, rating: 1, text: 'Reported abusive content fixture', editableUntil: new Date() } });
  const invoke = async (handler: typeof submitTrustCase, userId: string, body: object, id?: string) => {
    let data: any; let error: unknown;
    await handler({ user: { id: userId }, body, params: { id } } as never, { status() { return this; }, json(value: unknown) { data = value; return this; } } as never, value => { error = value; });
    if (error) throw error; return data;
  };
  await t.test('existing disputes retain the 48-hour response opportunity and policy finding', async () => {
    const existing = await prisma.trustCase.create({ data: { userId: recipient.id, respondentId: author.id, reviewId: review.id, description: 'A review dispute submitted before new reports were removed.' } });
    const item = { data: existing };
    const decision = { uphold: true, violation: 'HARASSMENT', reason: 'Documented abusive content violates the review policy.' };
    await assert.rejects(invoke(decideTrustCase, admin.id, decision, item.data.id), /48 hours/);
    await assert.rejects(invoke(respondToTrustCase, recipient.id, { response: 'The recipient cannot pretend to be the original review author.' }, item.data.id), /other participant/);
    await invoke(respondToTrustCase, author.id, { response: 'Here is my explanation of the original wording and experience.' }, item.data.id);
    await invoke(decideTrustCase, admin.id, decision, item.data.id);
    assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.id } })).visibility, 'HIDDEN');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } })).trustScore, 50);
  });
  await t.test('pre-key legacy reviews and floor-clamped deductions are removed by replay', async () => {
    const account = await user('user', 3);
    const events = [
      { eventKey: `account-baseline:${account.id}`, reason: 'Baseline', delta: 50, scoreBefore: 0, scoreAfter: 50 },
      { eventKey: null, reason: 'Documented old manual adjustment', delta: -47, scoreBefore: 50, scoreAfter: 3 },
      { eventKey: null, reason: 'Received 1-star provider review', delta: -3, scoreBefore: 3, scoreAfter: 0 },
      { eventKey: `booking-completion:legacy:${account.id}`, reason: 'Legacy completion', delta: 3, scoreBefore: 0, scoreAfter: 3, category: 'COMPLETION' },
    ];
    for (let i = 0; i < events.length; i++) await prisma.trustScoreEvent.create({ data: { ...events[i], userId: account.id, createdAt: new Date(1700000000000 + i * 1000) } });
    const migration = readFileSync('prisma/migrations/20261011120000_evidence_based_trust/migration.sql', 'utf8');
    const classification = migration.match(/UPDATE trust_score_events SET category = 'REVIEW_LEGACY'[\s\S]*?;/)![0];
    const replay = migration.match(/DO \$\$[\s\S]*?END \$\$;/)![0];
    await prisma.$transaction(async tx => { await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`); await tx.$executeRawUnsafe(classification); await tx.$executeRawUnsafe(replay); });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).trustScore, 6);
    assert.equal(await prisma.trustScoreEvent.count({ where: { userId: account.id } }), 5);
  });
});
