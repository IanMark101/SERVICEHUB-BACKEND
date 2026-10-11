import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { CaptchaError, createCaptchaProtection, verifyCaptcha, type CaptchaConfig } from '../lib/captcha';

const instant = Date.parse('2026-10-07T06:00:00Z');
const config: CaptchaConfig = { enabled: true, siteKey: 'public-site-key', secretKey: 'private-secret-key', allowedHostnames: ['servicehubcordova.tech'] };
const token = 'a-valid-one-time-token-from-google';
const googleSuccess = { success: true, hostname: 'servicehubcordova.tech', challenge_ts: new Date(instant - 20_000).toISOString() };
const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test('Google verification sends only the token and server secret to the fixed provider endpoint', async () => {
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://www.google.com/recaptcha/api/siteverify');
    assert.equal(options?.method, 'POST');
    assert.ok(options?.signal);
    const body = options?.body as URLSearchParams;
    assert.equal(body.get('secret'), config.secretKey);
    assert.equal(body.get('response'), token);
    assert.equal(body.get('remoteip'), null);
    return new Response(JSON.stringify(googleSuccess));
  };
  await verifyCaptcha(token, config, fetcher);
});

test('missing and malformed tokens stop before calling Google', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('Should not run'); };
  for (const invalid of [undefined, null, '', 'short', { checked: true }, 'x'.repeat(4097)]) {
    await assert.rejects(verifyCaptcha(invalid, config, fetcher), (error: unknown) => error instanceof CaptchaError && error.code === 'CAPTCHA_REQUIRED');
  }
  assert.equal(calls, 0);
});

test('rejected, reused, expired, foreign-host and malformed provider answers fail closed', async () => {
  for (const body of [
    { ...googleSuccess, success: false },
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { ...googleSuccess, hostname: 'attacker.example' },
    { ...googleSuccess, hostname: 'sub.servicehubcordova.tech' },
    { ...googleSuccess, challenge_ts: 'invalid' },
    { ...googleSuccess, success: 'true' }, null, {},
  ]) {
    await assert.rejects(verifyCaptcha(token, config, reply(body)), (error: unknown) => error instanceof CaptchaError && error.code === 'CAPTCHA_REQUIRED');
  }
});

test('accepts Google-approved answers after a slow solve instead of treating challenge load time as token age', async () => {
  await verifyCaptcha(token, config, reply({ ...googleSuccess, challenge_ts: new Date(Date.now() - 10 * 60_000).toISOString() }));
  await assert.rejects(
    verifyCaptcha(token, config, reply({ success: false, 'error-codes': ['timeout-or-duplicate'] })),
    (error: unknown) => error instanceof CaptchaError && error.code === 'CAPTCHA_REQUIRED',
  );
});

test('provider outages and invalid secret configuration block protected actions without exposing the secret', async () => {
  for (const fetcher of [reply({}, 503), reply({ success: false, 'error-codes': ['invalid-input-secret'] }), (async () => { throw new Error(config.secretKey); }) as typeof fetch, (async () => new Response('not JSON')) as typeof fetch]) {
    await assert.rejects(verifyCaptcha(token, config, fetcher), (error: unknown) => error instanceof CaptchaError && error.code === 'CAPTCHA_UNAVAILABLE' && !error.message.includes(config.secretKey));
  }
  await assert.rejects(verifyCaptcha(token, { ...config, allowedHostnames: [] }), (error: unknown) => error instanceof CaptchaError && error.code === 'CAPTCHA_UNAVAILABLE');
});

test('disabled protection preserves existing authentication without a provider request', async () => {
  await verifyCaptcha(undefined, { ...config, enabled: false }, (async () => { throw new Error('Must not contact Google'); }) as typeof fetch);
});

test('HTTP guards protect registration and reset requests, challenge the fourth failed login, and preserve OAuth', async (t) => {
  let time = instant;
  let verificationCalls = 0;
  let protectedActions = 0;
  const protection = createCaptchaProtection(config, async (proof) => {
    verificationCalls++;
    if (proof !== token) throw new CaptchaError('CAPTCHA_REQUIRED', 'Complete security verification.');
  }, () => time);
  const app = express();
  app.use(express.json());
  app.get('/config', protection.publicConfig);
  for (const path of ['/register', '/forgot-password']) {
    app.post(path, protection.requireCaptcha, (_req, res) => { protectedActions++; res.json({ success: true }); });
  }
  app.post('/login', protection.passwordLoginCaptcha, (req, res) => res.status(req.body.password === 'correct' ? 200 : 401).json({ success: req.body.password === 'correct' }));
  app.post('/google-login', (_req, res) => res.json({ success: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  for (const path of ['/register', '/forgot-password']) {
    assert.equal((await post(path, {})).status, 403);
    assert.equal((await post(path, { captchaToken: token })).status, 200);
  }
  assert.equal(protectedActions, 2, 'Only verified requests reach account creation or email delivery');
  const publicResponse = await fetch(base + '/config');
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
  const publicBody = await publicResponse.text();
  assert.ok(!publicBody.includes(config.secretKey));
  assert.equal(JSON.parse(publicBody).data.loginRequired, false);
  const callsBeforeLogin = verificationCalls;
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await post('/login', { password: 'incorrect' })).status, 401);
  assert.equal(verificationCalls, callsBeforeLogin);
  assert.equal((await (await fetch(base + '/config')).json()).data.loginRequired, true);
  assert.equal((await post('/login', { password: 'correct' })).status, 403, 'Passwords cannot bypass a required challenge');
  assert.equal((await post('/google-login', {})).status, 200);
  assert.equal((await post('/login', { password: 'correct', captchaToken: token })).status, 200);
  assert.equal((await (await fetch(base + '/config')).json()).data.loginRequired, false);
  for (let attempt = 0; attempt < 3; attempt++) await post('/login', { password: 'incorrect' });
  time += 15 * 60_000 + 1;
  assert.equal((await (await fetch(base + '/config')).json()).data.loginRequired, false, 'Failed-login policy expires');
});

test('IPv6 address rotation within one subnet cannot avoid the failed-login challenge', async () => {
  const protection = createCaptchaProtection(config, async () => { throw new CaptchaError('CAPTCHA_REQUIRED', 'Check required'); });
  // Exercise Express response lifecycle without a real account or database.
  const { EventEmitter } = await import('node:events');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = Object.assign(new EventEmitter(), { statusCode: 401 });
    await protection.passwordLoginCaptcha({ ip: `2001:db8::${attempt}`, body: {} } as express.Request, res as unknown as express.Response, () => {});
    res.emit('finish');
  }
  let required = false;
  protection.publicConfig({ ip: '2001:db8::ffff' } as express.Request, { setHeader() {}, json(body: { data: { loginRequired: boolean } }) { required = body.data.loginRequired; } } as unknown as express.Response, () => {});
  assert.equal(required, true);
});

test('approved proxy headers isolate login risk by client, while untrusted forwarded headers cannot rotate risk', async (t) => {
  for (const trustedProxy of [false, 'loopback'] as const) {
    const protection = createCaptchaProtection(config, async () => { throw new CaptchaError('CAPTCHA_REQUIRED', 'Check required'); });
    const app = express();
    app.set('trust proxy', trustedProxy);
    app.get('/config', protection.publicConfig);
    app.post('/login', protection.passwordLoginCaptcha, (_req, res) => res.sendStatus(401));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await fetch(base + '/login', { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.10' } })).status, 401);
    }
    const required = async (forwarded: string) => (await (await fetch(base + '/config', { headers: { 'X-Forwarded-For': forwarded } })).json()).data.loginRequired;
    assert.equal(await required('203.0.113.10'), true);
    assert.equal(await required('203.0.113.20'), !trustedProxy, 'Only a trusted proxy can distinguish another client');
    assert.equal(await required('198.51.100.99, 203.0.113.10'), true, 'Untrusted addresses prepended by a client cannot replace the nearest client IP');
  }
});

test('risk tracking at capacity challenges requests without evicting active failed-login records', async () => {
  const { EventEmitter } = await import('node:events');
  let time = instant;
  const protection = createCaptchaProtection(config, async () => {}, () => time, 1);
  for (const ip of ['203.0.113.10', '203.0.113.20']) {
    const res = Object.assign(new EventEmitter(), { statusCode: 401 });
    await protection.passwordLoginCaptcha({ ip } as express.Request, res as unknown as express.Response, () => {});
    res.emit('finish');
  }
  const required = () => {
    let challenged = false;
    protection.publicConfig({ ip: '203.0.113.30' } as express.Request, { setHeader() {}, json(body: { data: { loginRequired: boolean } }) { challenged = body.data.loginRequired; } } as unknown as express.Response, () => {});
    return challenged;
  };
  assert.equal(required(), true);
  time += 15 * 60_000 + 1;
  assert.equal(required(), false);
});
