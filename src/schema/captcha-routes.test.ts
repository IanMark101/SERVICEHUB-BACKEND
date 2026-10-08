import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

test('actual auth routes reject missing CAPTCHA before account creation or email delivery', async (t) => {
  // Only this isolated test process is configured; no real .env is changed.
  process.env.RECAPTCHA_ENABLED = 'true';
  process.env.RECAPTCHA_SITE_KEY = 'test-fixture-public-key';
  process.env.RECAPTCHA_SECRET_KEY = 'test-fixture-private-key';
  process.env.RECAPTCHA_ALLOWED_HOSTNAMES = 'localhost';
  const { default: app } = await import('../app');
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
  // Invalid OAuth input must still reach its own schema, not a CAPTCHA guard.
  const oauth = await fetch(base + '/google-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(oauth.status, 400);
  assert.notEqual((await oauth.json()).code, 'CAPTCHA_REQUIRED');
});
