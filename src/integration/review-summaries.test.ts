import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { invalidateReviewSummaries, summarizeProviderReviews, summarizeSeekerReviews } from '../services/ai.service';

test('review digests remain grounded and isolated by booking role', async t => {
  const schema = new URL(env.DATABASE_URL).searchParams.get('schema');
  assert.match(schema ?? '', /^audit_20260924_[a-f0-9]{32}$/, 'Run only through the fresh isolated audit harness');
  const savedKey = env.GEMINI_API_KEY;
  const savedFetch = globalThis.fetch;
  env.GEMINI_API_KEY = '';
  const suffix = randomUUID();
  const account = (name: string) => prisma.user.create({ data: { name, email: `${name}-${suffix}@example.test`, passwordHash: 'test-only', location: 'Cordova', phone: 'test-only', emailVerified: true, verificationStatus: 'APPROVED' } });
  const [a, b, outsider] = await Promise.all(['dual-role', 'counterparty', 'outsider'].map(account));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    env.GEMINI_API_KEY = savedKey; globalThis.fetch = savedFetch;
    server.close(); server.closeAllConnections();
    await prisma.$disconnect();
  });
  const add = async (context: 'provider' | 'seeker', rating: number, options: { text?: string; hidden?: boolean; wrongAuthor?: boolean; incomplete?: boolean; tags?: string[]; createdAt?: Date } = {}) => {
    const providerId = context === 'provider' ? a.id : b.id;
    const seekerId = context === 'provider' ? b.id : a.id;
    const booking = await prisma.booking.create({ data: { seekerId, providerId, status: options.incomplete ? 'ONGOING' : 'COMPLETED', agreedAmount: 500, paymentMethod: 'On-site Cash', paymentStatus: 'CASH_CONFIRMED' } });
    const cs = await prisma.completedService.create({ data: { seekerId, providerId, bookingId: booking.id, finalPrice: 500, paymentStatus: 'CASH_CONFIRMED' } });
    return prisma.review.create({ data: { completedServiceId: cs.id, authorId: options.wrongAuthor ? outsider.id : b.id, targetId: a.id,
      rating, text: options.text ?? null, tags: options.tags ?? [], visibility: options.hidden ? 'HIDDEN' : 'VISIBLE', editableUntil: new Date(Date.now() + 86400000), createdAt: options.createdAt } });
  };
  await t.test('only visible reviews from the actual counterparty on completed work are counted', async () => {
    await add('provider', 5, { tags: ['Friendly', 'Friendly'] });
    await add('provider', 1, { hidden: true });
    await add('provider', 1, { wrongAuthor: true });
    await add('provider', 1, { incomplete: true });
    await add('seeker', 2, { tags: ['Respectful'] });
    const provider = await summarizeProviderReviews(a.id);
    const client = await summarizeSeekerReviews(a.id);
    assert.equal(provider.averageRating, 5); assert.equal(provider.reviewCount, 1);
    assert.match(provider.summary!, /Friendly \(1 review\)/);
    assert.equal(client.averageRating, 2); assert.equal(client.reviewCount, 1);
    assert.match(client.summary!, /this client/);
    assert.match(client.summary!, /Respectful/);
    const persisted = await prisma.aiReviewSummary.findUniqueOrThrow({ where: { providerId: a.id } });
    assert.match(persisted.summary, /this provider/);
  });
  await t.test('client edits and moderation invalidate facts even with an existing memory cache', async () => {
    const r = await add('seeker', 4);
    assert.equal((await summarizeSeekerReviews(a.id)).averageRating, 3);
    await prisma.review.update({ where: { id: r.id }, data: { rating: 5, contentVersion: { increment: 1 } } });
    assert.equal((await summarizeSeekerReviews(a.id)).averageRating, 3.5);
    await prisma.review.update({ where: { id: r.id }, data: { visibility: 'HIDDEN', contentVersion: { increment: 1 } } });
    assert.equal((await summarizeSeekerReviews(a.id)).reviewCount, 1);
    assert.equal((await summarizeProviderReviews(a.id)).averageRating, 5);
  });
  await t.test('old provider cache algorithms cannot preserve unsupported claims', async () => {
    invalidateReviewSummaries(a.id);
    await prisma.aiReviewSummary.update({ where: { providerId: a.id }, data: { contentVersion: 'old-algorithm', source: 'gemini', summary: 'Unsupported old claim.' } });
    const digest = await summarizeProviderReviews(a.id);
    assert.equal(digest.source, 'computed');
    assert.doesNotMatch(digest.summary!, /Unsupported/);
  });
  await t.test('client endpoint requires login and returns the client role, including a normal no-history state', async () => {
    assert.equal((await savedFetch(`${base}/ai/seeker-summary/${a.id}`)).status, 401);
    const session = await prisma.refreshToken.create({ data: { userId: b.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
    const token = jwt.sign({ sub: b.id, role: 'user', sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    const headers = { Authorization: `Bearer ${token}` };
    const response = await savedFetch(`${base}/ai/seeker-summary/${a.id}?fast=1`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.data.reviewContext, 'seeker'); assert.equal(body.data.averageRating, 2);
    const empty = await (await savedFetch(`${base}/ai/seeker-summary/${outsider.id}?fast=1`, { headers })).json() as any;
    assert.equal(empty.data.source, 'empty'); assert.equal(empty.data.summary, null);
  });
  await t.test('latest twenty reviews set the scope and exclude older ratings', async () => {
    for (let i = 0; i < 21; i++) await add('provider', i === 0 ? 1 : 4, { createdAt: new Date(Date.now() + i * 1000) });
    const digest = await summarizeProviderReviews(a.id);
    assert.equal(digest.reviewCount, 20); assert.equal(digest.averageRating, 4);
    assert.match(digest.summary!, /20 recent client reviews/);
  });
  await t.test('AI output selects original excerpts and keeps computed rating facts', async () => {
    for (let i = 0; i < 5; i++) await add('seeker', i === 0 ? 1 : 5, { text: i === 0 ? 'The scope changed after we agreed.' : 'Instructions were clear and payment was prompt.' });
    env.GEMINI_API_KEY = 'mock-no-external-call';
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text;
      const rows = JSON.parse(prompt.split('\n\n').at(-1)!);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reviewIds: [rows.find((r: any) => r.rating === 1).reviewId, rows.find((r: any) => r.rating === 5).reviewId] }) }] } }] }));
    };
    const digest = await summarizeSeekerReviews(a.id);
    assert.equal(digest.source, 'gemini'); assert.equal(digest.averageRating, 3.8);
    assert.match(digest.summary!, /scope changed/); assert.match(digest.summary!, /payment was prompt/);
    assert.equal((await summarizeSeekerReviews(a.id)).cached, true); assert.equal(calls, 1);
  });
  await t.test('invented model prose falls back to the verified calculated digest', async () => {
    invalidateReviewSummaries(a.id);
    globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'This client is always perfect and rated 5/5.' }] } }] }));
    const digest = await summarizeSeekerReviews(a.id);
    assert.equal(digest.source, 'computed'); assert.equal(digest.averageRating, 3.8);
    assert.doesNotMatch(digest.summary!, /always perfect/);
  });
  await t.test('review changes during a pending AI request cannot return hidden feedback', async () => {
    invalidateReviewSummaries(a.id);
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    globalThis.fetch = async () => { reached(); await gate; return new Response('{}', { status: 503 }); };
    const pending = summarizeSeekerReviews(a.id);
    await started;
    await prisma.review.updateMany({ where: { targetId: a.id, completedService: { seekerId: a.id } }, data: { visibility: 'HIDDEN', contentVersion: { increment: 1 } } });
    release();
    const result = await pending;
    assert.equal(result.source, 'empty'); assert.equal(result.summary, null);
  });
});
