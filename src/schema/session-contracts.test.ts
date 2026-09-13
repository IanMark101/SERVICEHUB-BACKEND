import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { session } from '../controllers/auth.controller';

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

