import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIsolatedLocalTestTarget } from '../../scripts/isolated-local-test-target';

const environment = {
  NODE_ENV: 'test', SERVICEHUB_LOCAL_TEST_DATABASE: '1',
  DATABASE_URL: 'postgresql://fixture:example@127.0.0.1:55432/servicehub_ci',
  DIRECT_URL: 'postgresql://fixture:example@127.0.0.1:55432/servicehub_ci',
};

test('local migration tests accept only an explicitly selected loopback CI database', () => {
  assert.doesNotThrow(() => assertIsolatedLocalTestTarget(environment));
  assert.doesNotThrow(() => assertIsolatedLocalTestTarget({ ...environment,
    DATABASE_URL: 'postgresql://fixture:example@localhost/servicehub_ci',
    DIRECT_URL: 'postgresql://fixture:example@localhost:5432/servicehub_ci',
  }));
});

test('local migration tests refuse production mode, hosted databases, other databases and custom search paths', () => {
  for (const overrides of [
    { NODE_ENV: 'production' }, { SERVICEHUB_LOCAL_TEST_DATABASE: undefined },
    { DIRECT_URL: undefined },
    { DATABASE_URL: 'postgresql://fixture:example@database.example.test/servicehub_ci' },
    { DATABASE_URL: 'postgresql://fixture:example@127.0.0.1:55432/servicehub' },
    { DATABASE_URL: `${environment.DATABASE_URL}?schema=production` },
    { DATABASE_URL: `${environment.DATABASE_URL}?options=-c%20search_path=production` },
    { DATABASE_URL: 'https://127.0.0.1:55432/servicehub_ci' },
    { DIRECT_URL: 'postgresql://fixture:example@127.0.0.1:55433/servicehub_ci' },
  ]) {
    assert.throws(() => assertIsolatedLocalTestTarget({ ...environment, ...overrides }));
  }
});
