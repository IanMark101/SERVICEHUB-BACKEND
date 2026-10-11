import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Prisma } from '@prisma/client';

test('registration email checks and final conflicts use the actual auth routes without touching real accounts', async t => {
  process.env.RECAPTCHA_ENABLED = 'true';
  process.env.RECAPTCHA_SITE_KEY = 'fixture-public-key';
  process.env.RECAPTCHA_SECRET_KEY = 'fixture-private-key';
  process.env.RECAPTCHA_ALLOWED_HOSTNAMES = 'localhost';
  const { default: app } = await import('../app');
  const { prisma } = await import('../lib/prisma');
  const users = [
    { id: 'google-account', email: 'google@example.com', passwordState: 'NONE', googleSubject: 'private-google-subject' },
    { id: 'password-account', email: 'Password@example.com', passwordState: 'SET', googleSubject: null },
  ];
  let lookups = 0;
  let transactions = 0;
  let race = false;
  let raceLookups = 0;
  const model = prisma.user as unknown as Record<string, unknown>;
  const originalLookup = model.findFirst;
  const originalTransaction = prisma.$transaction;
  t.after(() => { model.findFirst = originalLookup; prisma.$transaction = originalTransaction; });
  model.findFirst = async (query: { where: { email: { equals: string; mode: string } }; select: object }) => {
    lookups++;
    assert.equal(query.where.email.mode, 'insensitive');
    assert.deepEqual(query.select, { id: true });
    if (race) return ++raceLookups === 1 ? null : { id: 'concurrent-account' };
    const match = users.find(user => user.email.toLowerCase() === query.where.email.equals.toLowerCase());
    return match ? { id: match.id } : null;
  };
  prisma.$transaction = (async () => {
    transactions++;
    if (race) throw new Prisma.PrismaClientKnownRequestError('Fixture duplicate email', { code: 'P2002', clientVersion: '7.10.0', meta: { target: ['email'] } });
    throw new Error('Account creation must never run in this test');
  }) as typeof prisma.$transaction;
  const transport = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== 'https://www.google.com/recaptcha/api/siteverify') return transport(input, options);
    return new Response(JSON.stringify({ success: true, hostname: 'localhost', challenge_ts: new Date().toISOString() }));
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  const post = (path: string, body: unknown) => transport(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await t.test('Google and password emails are unavailable, including case/whitespace variants, without revealing account information', async () => {
    for (const email of ['google@example.com', ' GOOGLE@EXAMPLE.COM ', 'password@example.com']) {
      const response = await post('/check-email', { email });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { success: true, data: { available: false } });
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal(transactions, 0);
  });

  await t.test('a new email is available and malformed input does not query accounts', async () => {
    const response = await post('/check-email', { email: 'new@example.com' });
    assert.deepEqual(await response.json(), { success: true, data: { available: true } });
    const before = lookups;
    for (const body of [{ email: 'invalid' }, { email: 'x'.repeat(255) + '@example.com' }, { email: 'new@example.com', password: 'unexpected' }]) {
      const invalid = await post('/check-email', body);
      assert.equal(invalid.status, 400);
      await invalid.json();
    }
    assert.equal(lookups, before);
    assert.equal(transactions, 0);
  });

  const account = { name: 'Fixture Resident', email: 'google@example.com', password: 'ValidPassword1!', phone: '+63 917 123 4567', location: 'Babag 2, Lapu-Lapu City, Cebu', captchaToken: 'fixture-single-use-registration-proof' };
  await t.test('final registration still requires CAPTCHA and rejects an existing Google account before writes', async () => {
    const unverified = await post('/register', { ...account, captchaToken: undefined });
    assert.equal(unverified.status, 403);
    assert.equal((await unverified.json()).code, 'CAPTCHA_REQUIRED');
    const duplicate = await post('/register', { ...account, email: 'GOOGLE@example.com' });
    assert.equal(duplicate.status, 409);
    const body = await duplicate.json();
    assert.equal(body.code, 'EMAIL_ALREADY_REGISTERED');
    assert.match(body.error, /already registered/);
    assert.equal(duplicate.headers.get('set-cookie'), null);
    assert.equal(transactions, 0);
  });

  await t.test('an email claimed after the initial check returns the same conflict rather than a server error', async () => {
    race = true;
    const response = await post('/register', { ...account, email: 'concurrent@example.com' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'EMAIL_ALREADY_REGISTERED');
    assert.equal(transactions, 1);
    assert.equal(raceLookups, 2);
    race = false;
  });

  await t.test('successful availability checks also exhaust the dedicated rate limit', async () => {
    const first = await post('/check-email', { email: 'new@example.com' });
    assert.equal(first.status, 200);
    await first.json();
    const remaining = Number(/remaining=(\d+)/.exec(first.headers.get('ratelimit') || '')?.[1]);
    assert.ok(Number.isFinite(remaining));
    for (let index = 0; index < remaining; index++) {
      const response = await post('/check-email', { email: 'new@example.com' });
      assert.equal(response.status, 200);
      await response.json();
    }
    const before = lookups;
    const limited = await post('/check-email', { email: 'new@example.com' });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Too many email checks/);
    assert.equal(lookups, before);
    assert.equal(transactions, 1);
  });
});
