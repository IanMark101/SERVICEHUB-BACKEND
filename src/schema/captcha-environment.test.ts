import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEnvironment } from '../config/env';

const base = {
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  JWT_ACCESS_SECRET: 'test-access-secret-long-enough', JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough',
  NODE_ENV: 'production', PAYMONGO_PUBLIC_KEY: 'test-public', PAYMONGO_SECRET_KEY: 'test-secret', PAYMONGO_WEBHOOK_SECRET: 'test-signing-secret-long-enough',
};
test('CAPTCHA defaults off and enabled deployment requires both keys and exact hostnames', () => {
  assert.equal(validateEnvironment(base).success, true);
  assert.equal(validateEnvironment({ ...base, RECAPTCHA_ENABLED: 'true' }).success, false);
  const valid = { ...base, RECAPTCHA_ENABLED: 'true', RECAPTCHA_SITE_KEY: 'real-site-key', RECAPTCHA_SECRET_KEY: 'real-secret-key', RECAPTCHA_ALLOWED_HOSTNAMES: 'servicehubcordova.tech,www.servicehubcordova.tech' };
  assert.equal(validateEnvironment(valid).success, true);
  for (const hostname of ['', '*', '*.example.com', 'https://servicehubcordova.tech', 'localhost:3000', 'example.com/path']) {
    assert.equal(validateEnvironment({ ...valid, RECAPTCHA_ALLOWED_HOSTNAMES: hostname }).success, false);
  }
});
test('production cannot activate Google always-passing test keys', () => {
  const values = { ...base, RECAPTCHA_ENABLED: 'true', RECAPTCHA_ALLOWED_HOSTNAMES: 'localhost', RECAPTCHA_SITE_KEY: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI', RECAPTCHA_SECRET_KEY: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe' };
  assert.equal(validateEnvironment(values).success, false);
  assert.equal(validateEnvironment({ ...values, NODE_ENV: 'development' }).success, true);
});
