import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth, requireMarketplaceUser } from '../middlewares/auth.middleware';

function responseCapture() {
  let statusCode = 200;
  let body: any;
  return {
    response: {
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as Response,
    read: () => ({ statusCode, body }),
  };
}

test('missing bearer authentication returns 401 without querying protected data', async () => {
  const target = responseCapture();
  let nextCalled = false;
  await requireAuth({ headers: {} } as Request, target.response, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(target.read().statusCode, 401);
  assert.equal(target.read().body.error, 'Authentication required');
  assert.equal(nextCalled, false);
});

test('administrator accounts cannot invoke standard marketplace actions', () => {
  const target = responseCapture();
  let nextCalled = false;
  requireMarketplaceUser(
    { user: { id: 'admin-1', role: 'admin' } } as unknown as Request,
    target.response,
    (() => { nextCalled = true; }) as NextFunction,
  );
  assert.equal(target.read().statusCode, 403);
  assert.equal(nextCalled, false);
});

test('new marketplace relationship routes retain authentication and verification gates', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const services = source('../routes/services.routes.ts');
  const requests = source('../routes/requests.routes.ts');
  const offers = source('../routes/offers.routes.ts');
  const bookings = source('../routes/bookings.routes.ts');

  assert.match(services, /router\.post\("\/", requireAuth, requireMarketplaceUser, requireVerification,/);
  assert.match(services, /router\.patch\("\/:id", requireAuth, requireMarketplaceUser, requireVerification,/);
  assert.match(services, /router\.patch\("\/:id\/toggle", requireAuth, requireMarketplaceUser, requireVerification,/);
  assert.match(requests, /router\.use\(requireAuth, requireMarketplaceUser\)/);
  assert.match(requests, /router\.post\("\/", requireVerification,/);
  assert.match(requests, /router\.patch\("\/:id", requireVerification,/);
  assert.match(offers, /router\.use\(requireAuth, requireMarketplaceUser\)/);
  assert.match(offers, /router\.post\("\/", requireVerification,/);
  assert.match(offers, /router\.patch\("\/:id\/accept", requireVerification,/);
  for (const route of [
    'router.post("/direct", requireVerification,',
    'router.post("/direct-from-offer", requireVerification,',
    'router.post("/initiate-payment", requireVerification,',
    'router.post("/confirm-online", requireVerification,',
    'router.post("/waitlist", requireVerification,',
    'router.patch("/queue/:id/start", requireVerification,',
  ]) {
    assert.equal(bookings.includes(route), true, `missing verification gate: ${route}`);
  }
});

test('existing-engagement resolution routes do not use the new-relationship verification gate', () => {
  const bookings = readFileSync(new URL('../routes/bookings.routes.ts', import.meta.url), 'utf8');
  for (const route of [
    'router.patch("/direct/:id/respond", respondDirectRequest)',
    'router.delete("/queue/:id", cancelQueue)',
    'router.patch("/queue/:id/complete", completeJob)',
    'router.post("/:id/dispute", disputeJob)',
    'router.post("/:id/reports", reportBookingSafety)',
    'router.post("/:id/confirm", confirmCompletion)',
    'router.post("/:id/completion-escalations", escalateCompletion)',
    'router.post("/:id/cancel", cancelBookingHandler)',
    'router.post("/cancellation-requests/:id/escalate", escalateCancellationRequestHandler)',
    'router.patch("/cancellation-requests/:id/respond", respondCancellationRequestHandler)',
  ]) {
    assert.equal(bookings.includes(route), true, `resolution route changed or became trapped: ${route}`);
  }
});
