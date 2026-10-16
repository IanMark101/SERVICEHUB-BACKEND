import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { settleCompletedBooking } from '../services/bookings/completion.service';
import { applyBookingTrustPenalty, awardBookingCompletionTrust } from '../services/trust-policy.service';
import { applyManualTrustAdjustment } from '../services/trust.service';
import { submitReview, updateReview } from '../controllers/reviews.controller';
import { moderateReview } from '../controllers/admin/reviews.controller';
import { submitTrustCase, decideTrustCase, respondToTrustCase, listTrustCases } from '../controllers/trust-cases.controller';
import { TrustAdjustmentSchema } from '../schema/marketplace.schema';

test('evidence-based trust in an isolated migrated schema', async t => {
  const schemaName = new URL(env.DATABASE_URL).searchParams.get('schema') ?? '';
  assert.match(schemaName, /^(servicehub_migration_test_|audit_20260924_)[a-f0-9]{32}$/);
  const previousKey = env.GEMINI_API_KEY; env.GEMINI_API_KEY = '';
  t.after(async () => { env.GEMINI_API_KEY = previousKey; await prisma.$disconnect(); });
  let sequence = 0; const tag = randomUUID();
  const account = (role = 'user', trustScore = 50, verified = true) => prisma.user.create({ data: {
    name: 'Trust policy test', email: `trust-v2-${tag}-${sequence++}@example.test`, passwordHash: 'not-a-login',
    phone: '', location: 'Cordova', role, trustScore, emailVerified: true, verificationStatus: verified ? 'APPROVED' : 'UNVERIFIED',
  } });
  const admin = await account('admin'); const otherAdmin = await account('admin');
  const score = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).trustScore;
  const booking = (providerId: string, seekerId: string) => prisma.booking.create({ data: {
    providerId, seekerId, status: 'AWAITING_CONFIRMATION', agreedAmount: 500,
    started: true, paymentMethod: 'On-site Cash', paymentStatus: 'UNPAID',
  } });
  const invoke = async (handler: typeof submitReview, id: string, body: object = {}, source?: string, role = 'user') => {
    let code = 200; let result: any; let error: unknown;
    await handler({ user: { id, role }, body, params: { id: source }, query: {} } as never,
      { status(value: number) { code = value; return this; }, json(value: unknown) { result = value; return this; }, setHeader() {} } as never,
      value => { error = value; });
    if (error) throw error;
    return { code, result };
  };

  await t.test('confirmed cash completion rewards both users once and switched roles cannot farm', async () => {
    const p = await account(); const s = await account(); const first = await booking(p.id, s.id);
    await settleCompletedBooking(first.id, { type: 'SEEKER', userId: s.id });
    await settleCompletedBooking(first.id, { type: 'SEEKER', userId: s.id });
    assert.equal(await score(p.id), 53); assert.equal(await score(s.id), 53);
    const next = await booking(s.id, p.id);
    await settleCompletedBooking(next.id, { type: 'SEEKER', userId: p.id });
    assert.equal(await score(p.id), 53); assert.equal(await score(s.id), 53);
    assert.equal(await prisma.trustScoreEvent.count({ where: { category: 'COMPLETION', userId: p.id } }), 1);
  });
  await t.test('concurrent completions share the pair limit; expired window allows another reward', async () => {
    const p = await account(); const s = await account(); const [a, b] = await Promise.all([booking(p.id, s.id), booking(s.id, p.id)]);
    await Promise.all([settleCompletedBooking(a.id, { type: 'SEEKER', userId: s.id }), settleCompletedBooking(b.id, { type: 'SEEKER', userId: p.id })]);
    assert.equal(await score(p.id), 53); assert.equal(await score(s.id), 53);
    await prisma.trustScoreEvent.updateMany({ where: { userId: { in: [p.id, s.id] } }, data: { createdAt: new Date(Date.now() - 8 * 86400000) } });
    const c = await booking(p.id, s.id); await settleCompletedBooking(c.id, { type: 'SEEKER', userId: s.id });
    assert.equal(await score(p.id), 56); assert.equal(await score(s.id), 56);
  });
  await t.test('unapproved identity blocks rewards; clamped awards still use the pair window', async () => {
    const p = await account('user', 100); const s = await account('user', 50, false);
    const a = await booking(p.id, s.id); await settleCompletedBooking(a.id, { type: 'SEEKER', userId: s.id });
    assert.equal(await score(s.id), 50);
    await prisma.user.update({ where: { id: s.id }, data: { verificationStatus: 'APPROVED' } });
    const b = await booking(p.id, s.id); await settleCompletedBooking(b.id, { type: 'SEEKER', userId: s.id });
    assert.equal(await score(p.id), 100); assert.equal(await score(s.id), 53);
    assert.equal((await prisma.trustScoreEvent.findFirstOrThrow({ where: { bookingId: b.id, userId: p.id } })).delta, 0);
  });
  await t.test('open cases defer rewards; an uncorrected at-fault participant receives none', async () => {
    const p = await account(); const s = await account(); const a = await booking(p.id, s.id);
    const report = await prisma.report.create({ data: { bookingId: a.id, reporterId: s.id, reportedUserId: p.id, reason: 'INCOMPLETE_SERVICE', description: 'Test complaint with booking evidence' } });
    await settleCompletedBooking(a.id, { type: 'SEEKER', userId: s.id }); assert.equal(await score(p.id), 50);
    await prisma.$transaction(async tx => {
      await tx.report.update({ where: { id: report.id }, data: { status: 'RESOLVED' } });
      await applyBookingTrustPenalty(tx, { bookingId: a.id, userId: p.id, adminId: admin.id,
        eventKey: `report:${report.id}:trust-penalty`, category: 'REPORT_PENALTY', reason: 'Confirmed harassment evidenced by the booking messages' });
      await awardBookingCompletionTrust(tx, a.id);
    });
    assert.equal(await score(p.id), 40); assert.equal(await score(s.id), 53);
  });
  await t.test('all ratings, edits and moderation are trust-neutral; low stars require explanations', async () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      const p = await account(); const s = await account(); const a = await booking(p.id, s.id);
      const done = await settleCompletedBooking(a.id, { type: 'SEEKER', userId: s.id });
      if (rating <= 2) await assert.rejects(invoke(submitReview, s.id, { completedServiceId: done.id, rating }), /Explain/);
      const created = await invoke(submitReview, s.id, { completedServiceId: done.id, rating, text: 'Feedback about the completed booking' });
      const id = created.result.data.id;
      await invoke(updateReview, s.id, { rating: 1, text: 'Changed opinion about this experience' }, id);
      await invoke(moderateReview, admin.id, { action: 'hide', violation: 'HARASSMENT', reason: 'Abusive statements documented in this review' }, id, 'admin');
      await invoke(moderateReview, admin.id, { action: 'restore', reason: 'Review restored after checking the actual context' }, id, 'admin');
      assert.equal(await score(p.id), 53); assert.equal(await score(s.id), 53);
      assert.equal(await prisma.trustScoreEvent.count({ where: { eventKey: { startsWith: `review:${id}` } } }), 0);
      assert.equal((await invoke(submitReview, s.id, { completedServiceId: done.id, rating: 3 })).code, 409);
    }
  });
  await t.test('one booking penalty, no self-decision, appeal ownership and independent correction', async () => {
    const p = await account(); const s = await account(); const a = await booking(p.id, s.id);
    const input = { bookingId: a.id, userId: p.id, adminId: admin.id, category: 'CANCELLATION_PENALTY' as const, eventKey: `cancellation:${a.id}:${p.id}`, reason: 'Provider abandoned started work, as confirmed in booking messages' };
    await prisma.$transaction(tx => applyBookingTrustPenalty(tx, input));
    await prisma.$transaction(tx => applyBookingTrustPenalty(tx, { ...input, category: 'REPORT_PENALTY', eventKey: `report:${a.id}:penalty` }));
    assert.equal(await score(p.id), 45);
    await assert.rejects(prisma.$transaction(tx => applyBookingTrustPenalty(tx, { ...input, adminId: s.id })), /cannot decide/);
    const event = await prisma.trustScoreEvent.findFirstOrThrow({ where: { userId: p.id } });
    await assert.rejects(invoke(submitTrustCase, s.id, { trustEventId: event.id, description: 'I want to appeal someone else’s finding.' }), /own account/);
    const appeal = await invoke(submitTrustCase, p.id, { trustEventId: event.id, description: 'The messages document an emergency and mutual agreement.' });
    await assert.rejects(invoke(decideTrustCase, admin.id, { uphold: true, reason: 'Original penalty was not supported by the messages.' }, appeal.result.data.id, 'admin'), /Another active/);
    await invoke(decideTrustCase, otherAdmin.id, { uphold: true, reason: 'Original penalty was not supported by the messages.' }, appeal.result.data.id, 'admin');
    assert.equal(await score(p.id), 50);
    await assert.rejects(invoke(decideTrustCase, otherAdmin.id, { uphold: true, reason: 'Repeated decision must not add another reversal.' }, appeal.result.data.id, 'admin'), /already been decided/);
    assert.equal((await invoke(listTrustCases, s.id)).result.data.length, 0);
  });
  await t.test('new review reports are rejected and existing disputes retain their private response and moderation safeguards', async () => {
    const p = await account(); const s = await account(); const a = await booking(p.id, s.id);
    const done = await settleCompletedBooking(a.id, { type: 'SEEKER', userId: s.id });
    const review = await invoke(submitReview, s.id, { completedServiceId: done.id, rating: 1, text: 'I did not like the service experience.' });
    for (const userId of [s.id, p.id]) {
      await assert.rejects(invoke(submitTrustCase, userId, { reviewId: review.result.data.id, description: 'This review contains unrelated abusive statements.' }), error => error instanceof Error && error.name === 'ZodError');
    }
    assert.equal(await prisma.trustCase.count({ where: { reviewId: review.result.data.id } }), 0);
    const item = await prisma.trustCase.create({ data: { userId: p.id, respondentId: s.id, reviewId: review.result.data.id, description: 'A review dispute submitted before reports were removed.' } });
    await assert.rejects(invoke(respondToTrustCase, p.id, { response: 'The reporter cannot respond as the review author.' }, item.id), /other participant/);
    await invoke(respondToTrustCase, s.id, { response: 'The review describes my completed booking experience.' }, item.id);
    await assert.rejects(invoke(decideTrustCase, admin.id, { uphold: true, reason: 'The provider simply disagrees with this rating.' }, item.id, 'admin'), /policy violation/);
    await invoke(decideTrustCase, admin.id, { uphold: false, reason: 'This is genuine customer criticism and remains visible.' }, item.id, 'admin');
    assert.equal((await prisma.review.findUniqueOrThrow({ where: { id: review.result.data.id } })).visibility, 'VISIBLE');
    assert.equal(await score(p.id), 53);
  });
  await t.test('manual corrections reference an original event and cannot enter arbitrary points', async () => {
    const p = await account(); const s = await account(); const a = await booking(p.id, s.id);
    await settleCompletedBooking(a.id, { type: 'SEEKER', userId: s.id });
    const original = await prisma.trustScoreEvent.findFirstOrThrow({ where: { userId: p.id } });
    const input = { userId: p.id, adminId: admin.id, eventId: original.id, reason: 'This completion was recorded incorrectly and is corrected.', operationId: randomUUID() };
    await applyManualTrustAdjustment(input); await applyManualTrustAdjustment(input); assert.equal(await score(p.id), 50);
    await assert.rejects(applyManualTrustAdjustment({ ...input, operationId: randomUUID() }), /already been corrected/);
    assert.equal(TrustAdjustmentSchema.safeParse({ delta: 99, reason: input.reason, currentPassword: 'x', operationId: randomUUID() }).success, false);
  });
  await t.test('policy migration replays boundary-clamped history without deleting original events', async () => {
    const user = await account('user', 95);
    const timeline = [
      { eventKey: `account-baseline:${user.id}`, delta: 50, scoreBefore: 0, scoreAfter: 50 },
      { eventKey: `manual-trust:legacy:${user.id}`, delta: 48, scoreBefore: 50, scoreAfter: 98 },
      { eventKey: `review:legacy-${user.id}`, delta: 2, scoreBefore: 98, scoreAfter: 100 },
      { eventKey: `cancellation:legacy-${user.id}`, delta: -5, scoreBefore: 100, scoreAfter: 95 },
    ];
    for (let i = 0; i < timeline.length; i++) await prisma.trustScoreEvent.create({ data: { ...timeline[i], userId: user.id, reason: 'Legacy fixture', createdAt: new Date(1700000000000 + i * 1000) } });
    const migration = readFileSync('prisma/migrations/20261011120000_evidence_based_trust/migration.sql', 'utf8');
    const replay = migration.match(/DO \$\$[\s\S]*?END \$\$;/)![0];
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schemaName}"`);
      await tx.$executeRawUnsafe(replay);
    });
    assert.equal(await score(user.id), 93);
    assert.equal(await prisma.trustScoreEvent.count({ where: { userId: user.id } }), 5);
    const event = await prisma.trustScoreEvent.findUniqueOrThrow({ where: { eventKey: `trust-policy:v2:${user.id}` } });
    assert.equal(event.delta, -2); assert.equal(event.scoreBefore, 95); assert.equal(event.scoreAfter, 93);
  });
});
