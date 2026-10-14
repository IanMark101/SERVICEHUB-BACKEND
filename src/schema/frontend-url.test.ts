import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalFrontendUrl, PRODUCTION_FRONTEND_URL } from '../config/frontend-url';
import { validateEnvironment } from '../config/env';

test('frontend links migrate only known frontend aliases and preserve local and API configuration', () => {
  for (const host of ['servicehubcordova.tech', 'www.servicehubcordova.tech', 'servicehub.bond', 'www.servicehub.bond']) {
    assert.equal(canonicalFrontendUrl(`https://${host}/`, 'production'), PRODUCTION_FRONTEND_URL);
  }
  assert.equal(canonicalFrontendUrl(undefined, 'production'), PRODUCTION_FRONTEND_URL);
  assert.equal(canonicalFrontendUrl(undefined, 'development'), 'http://localhost:3000');
  for (const origin of ['http://localhost:3000', 'https://staging.example.test', 'https://api.servicehubcordova.tech']) {
    assert.equal(canonicalFrontendUrl(origin, 'production'), origin);
  }
});

test('validated runtime configuration supplies the new frontend for email and payment links', () => {
  const result = validateEnvironment({ DATABASE_URL: 'example', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), FRONTEND_URL: 'https://servicehubcordova.tech/', NODE_ENV: 'test' });
  assert.ok(result.success);
  assert.equal(result.data.FRONTEND_URL, PRODUCTION_FRONTEND_URL);
});
