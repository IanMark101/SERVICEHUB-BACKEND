import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { session } from '../controllers/auth.controller';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { recoverSession } from '../services/auth.service';

// Prisma model methods are proxy-backed rather than own property descriptors.
function stubModel(t: TestContext, delegate: 'refreshToken' | 'user', method: string, implementation: () => Promise<unknown>) {
  const model = prisma[delegate] as unknown as Record<string, unknown>;
  const original = model[method];
  model[method] = implementation;
  t.after(() => { model[method] = original; });
}

test('repeated cookie recovery returns a verified safe profile without rotation or duplicate profile reads', async t => {
  const token = jwt.sign({ sub: 'refresh-test-user', sid: 'refresh-test-session' }, env.JWT_REFRESH_SECRET, { expiresIn: '5m' });
  let sessionReads = 0;
  let userReads = 0;
  stubModel(t, 'refreshToken', 'findUnique', async () => {
    sessionReads++;
    return { id: 'refresh-test-session', userId: 'refresh-test-user', expiresAt: new Date(Date.now() + 300_000) };
  });
  stubModel(t, 'user', 'findUnique', async () => {
    userReads++;
    return { id: 'refresh-test-user', name: 'Refresh Test', role: 'user', isActive: true, emailVerified: true, moderationStatus: 'ACTIVE', passwordHash: 'must-not-leak', passwordState: 'SET', emailVerifyToken: 'must-not-leak', googleId: 'must-not-leak' };
  });
  stubModel(t, 'refreshToken', 'updateMany', async () => { throw new Error('Recovery must not rotate'); });
  for (let index = 0; index < 5; index++) {
    const result = await recoverSession(token);
    assert.equal(result.user.id, 'refresh-test-user');
    assert.equal(result.user.emailVerified, true);
    assert.ok(!JSON.stringify(result.user).includes('must-not-leak'));
    const claims = jwt.verify(result.accessToken, env.JWT_ACCESS_SECRET) as jwt.JwtPayload;
    assert.equal(claims.sid, 'refresh-test-session');
  }
  assert.equal(sessionReads, 5);
  assert.equal(userReads, 5);
});

test('a temporary database failure is an error, never a guest result or cookie deletion', async t => {
  const token = jwt.sign({ sub: 'refresh-test-user', sid: 'refresh-test-session' }, env.JWT_REFRESH_SECRET, { expiresIn: '5m' });
  stubModel(t, 'refreshToken', 'findUnique', async () => { throw new Error('Database temporarily unavailable'); });
  const json = t.mock.fn();
  const clearCookie = t.mock.fn();
  const next = t.mock.fn();
  await session({ cookies: { refreshToken: token } } as Request, { json, clearCookie } as unknown as Response, next);
  assert.equal(json.mock.callCount(), 0);
  assert.equal(clearCookie.mock.callCount(), 0);
  assert.equal(next.mock.callCount(), 1);
});

test('revoked sessions still produce a confirmed guest result and clear the invalid cookie', async t => {
  const token = jwt.sign({ sub: 'refresh-test-user', sid: 'revoked-session' }, env.JWT_REFRESH_SECRET, { expiresIn: '5m' });
  stubModel(t, 'refreshToken', 'findUnique', async () => null);
  const json = t.mock.fn();
  const clearCookie = t.mock.fn();
  const next = t.mock.fn();
  await session({ cookies: { refreshToken: token } } as Request, { json, clearCookie } as unknown as Response, next);
  assert.equal(json.mock.calls[0].arguments[0].data.authenticated, false);
  assert.equal(clearCookie.mock.callCount(), 1);
  assert.equal(next.mock.callCount(), 0);
});

test('an anonymous initial session probe returns 200 without an authentication error', async () => {
  let statusCode = 200;
  let body: any;
  let nextCalled = false;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as Response;

  await session(
    { cookies: {} } as Request,
    response,
    (() => { nextCalled = true; }) as NextFunction,
  );

  assert.equal(statusCode, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.authenticated, false);
  assert.equal(nextCalled, false);
});

test('session and refresh cookie endpoints retain trusted-origin protection', () => {
  const routes = readFileSync(new URL('../routes/auth.routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /router\.post\("\/session", requireTrustedOrigin, session\)/);
  assert.match(routes, /router\.post\("\/refresh", requireTrustedOrigin, refresh\)/);
  assert.match(routes, /router\.post\("\/logout", requireTrustedOrigin, logout\)/);
});

