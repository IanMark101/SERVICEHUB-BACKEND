import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

test('actual auth routes reject missing CAPTCHA before account creation or email delivery', async (t) => {
  // Only this isolated test process is configured; no real .env is changed.
  process.env.RECAPTCHA_ENABLED = 'true';
  process.env.RECAPTCHA_SITE_KEY = 'test-fixture-public-key';
  process.env.RECAPTCHA_SECRET_KEY = 'test-fixture-private-key';
  process.env.RECAPTCHA_ALLOWED_HOSTNAMES = 'localhost';
  process.env.TRUSTED_PROXY_CIDRS = 'loopback';
  const { default: app } = await import('../app');
  assert.deepEqual(app.get('trust proxy'), ['loopback']);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth`;
  for (const route of ['/register', '/forgot-password']) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'never-send@example.com' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CAPTCHA_REQUIRED');
  }
  const response = await fetch(base + '/captcha-config');
  const body = await response.text();
  assert.equal(JSON.parse(body).data.siteKey, 'test-fixture-public-key');
  assert.equal(JSON.parse(body).data.loginRequired, false);
  assert.ok(!body.includes('test-fixture-private-key'));

  // Exercise the real middleware/provider handoff using an isolated provider
  // fixture. Invalid account fields stop at schema validation, before DB/email.
  const transport = globalThis.fetch;
  const consumed = new Set<string>();
  let provider: 'valid' | 'foreign' | 'outage' = 'valid';
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== 'https://www.google.com/recaptcha/api/siteverify') return transport(input, options);
    if (provider === 'outage') return new Response('{}', { status: 503 });
    const proof = (options?.body as URLSearchParams).get('response')!;
    if (consumed.has(proof)) return new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
    consumed.add(proof);
    return new Response(JSON.stringify({
      success: true, hostname: provider === 'foreign' ? 'attacker.example' : 'localhost',
      challenge_ts: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
  });
  const post = (route: string, proof: string) => transport(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captchaToken: proof }),
  });
  for (const route of ['/register', '/forgot-password']) {
    const proof = `single-use-proof-for-${route}`;
    assert.equal((await post(route, proof)).status, 400, 'Verified proof reaches validation, but never creates an account or sends mail');
    const duplicate = await post(route, proof);
    assert.equal(duplicate.status, 403);
    assert.equal((await duplicate.json()).code, 'CAPTCHA_REQUIRED');
  }
  provider = 'foreign';
  assert.equal((await post('/register', 'foreign-host-proof-for-registration')).status, 403);
  provider = 'outage';
  const unavailable = await post('/forgot-password', 'unavailable-proof-for-recovery');
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, 'CAPTCHA_UNAVAILABLE');
  // Invalid OAuth input must still reach its own schema, not a CAPTCHA guard.
  const oauth = await fetch(base + '/google-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(oauth.status, 400);
  assert.notEqual((await oauth.json()).code, 'CAPTCHA_REQUIRED');
});
