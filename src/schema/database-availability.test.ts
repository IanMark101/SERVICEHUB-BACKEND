import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import { getDatabaseAvailabilityError } from '../utils/databaseAvailability';

const quotaMessage = 'Your account or project has exceeded the quota. Upgrade your plan to increase limits.';

test('Prisma quota failures become service unavailability without exposing the query or backend path', () => {
  const failure = Object.assign(new Error(`Invalid prisma.refreshToken.findUnique() invocation in C:\\private\\auth.middleware.ts:60\nDatabase error: ${quotaMessage}`), {
    name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '53000', message: quotaMessage },
  });
  const response = getDatabaseAvailabilityError(failure);
  assert.equal(response?.status, 503);
  assert.equal(response?.code, 'DATABASE_QUOTA_EXCEEDED');
  assert.equal(response?.error, 'ServiceHub is temporarily unavailable. Please try again later.');
  assert.doesNotMatch(JSON.stringify(response), /prisma|private|refreshToken|Upgrade/i);
});

test('quota detection handles nested adapter causes and explicit network-transfer limits', () => {
  const response = getDatabaseAvailabilityError({ name: 'PrismaClientUnknownRequestError',
    cause: { driverAdapterError: { cause: { code: '53000', message: 'Your project has exceeded the data transfer quota.' } } } });
  assert.equal(response?.code, 'DATABASE_QUOTA_EXCEEDED');
});

test('direct PostgreSQL quota failures are identified', () => {
  assert.equal(getDatabaseAvailabilityError({ code: '53000', message: quotaMessage })?.code, 'DATABASE_QUOTA_EXCEEDED');
});

test('resource and connection failures do not invent a quota diagnosis', () => {
  for (const code of ['53000', '53300', 'P1001', 'P2024']) {
    const response = getDatabaseAvailabilityError({ code, message: 'Database temporarily unavailable' });
    assert.equal(response?.status, 503);
    assert.equal(response?.code, 'DATABASE_UNAVAILABLE');
  }
});

test('unrelated business limits and constraint errors are not classified as outages', () => {
  assert.equal(getDatabaseAvailabilityError({ status: 409, message: 'Your listing quota has been exceeded.' }), null);
  assert.equal(getDatabaseAvailabilityError({ name: 'PrismaClientKnownRequestError', code: 'P2002', message: 'Unique constraint failed' }), null);
  assert.equal(getDatabaseAvailabilityError(null), null);
});

test('a quota failure while checking an authenticated session returns 503 without revoking the cookie', async t => {
  // A fake singleton is installed before importing the app; no database pool
  // or application record is used by this HTTP regression check.
  const failure = Object.assign(new Error(`Invalid prisma.refreshToken.findUnique() in C:\\private\\auth.middleware.ts: ${quotaMessage}`),
    { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '53000', message: quotaMessage } });
  const singleton = globalThis as unknown as { prisma?: PrismaClient };
  const previous = singleton.prisma;
  singleton.prisma = { refreshToken: { findUnique: async () => { throw failure; } } } as unknown as PrismaClient;
  t.after(() => { singleton.prisma = previous; });
  const [{ default: app }, { env }, { default: jwt }, { logger }] = await Promise.all([
    import('../app'), import('../config/env'), import('jsonwebtoken'), import('../utils/logger'),
  ]);
  const log = t.mock.method(logger, 'error', () => {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const token = jwt.sign({ sub: 'provider', role: 'user', sid: 'session' }, env.JWT_ACCESS_SECRET, { expiresIn: '30s' });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bookings/provider-workload`,
    { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 503);
  const body = await response.json() as { code: string; error: string; requestId: string };
  assert.equal(body.code, 'DATABASE_QUOTA_EXCEEDED');
  assert.doesNotMatch(body.error, /prisma|private|refreshToken|Upgrade/i);
  assert.ok(body.requestId);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(log.mock.calls[0].arguments[1]?.error, failure);
  const cookie = jwt.sign({ sub: 'provider', sid: 'session' }, env.JWT_REFRESH_SECRET, { expiresIn: '30s' });
  const recovery = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/session`, {
    method: 'POST', headers: { Cookie: `refreshToken=${cookie}`, Origin: env.FRONTEND_URL, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(recovery.status, 503);
  assert.equal((await recovery.json() as { code: string }).code, 'DATABASE_QUOTA_EXCEEDED');
  assert.equal(recovery.headers.get('set-cookie'), null);
  assert.equal(log.mock.calls[1].arguments[1]?.error, failure);
});
