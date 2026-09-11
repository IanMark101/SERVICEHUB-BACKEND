import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import app from '../app';

type ProtectedRoute = readonly [method: string, path: string];

const protectedRoutes: ProtectedRoute[] = [
  ['GET', '/api/auth/me'],
  ['PUT', '/api/auth/profile'],
  ['POST', '/api/auth/change-password'],
  ['GET', '/api/auth/profile/user-id'],
  ['GET', '/api/auth/trust-history'],
  ['GET', '/api/auth/trust-history/user-id'],
  ['GET', '/api/verifications/privacy-notice'],
  ['POST', '/api/verifications/submit'],
  ['GET', '/api/verifications/status'],
  ['GET', '/api/services/mine'],
  ['POST', '/api/services'],
  ['PATCH', '/api/services/service-id'],
  ['PATCH', '/api/services/service-id/toggle'],
  ['DELETE', '/api/services/service-id'],
  ['POST', '/api/categories/suggest'],
  ['GET', '/api/categories/suggestions/mine'],
  ['GET', '/api/bookings/my-engagements'],
  ['PATCH', '/api/bookings/booking-id/hide'],
  ['POST', '/api/bookings/direct'],
  ['PATCH', '/api/bookings/direct/request-id/respond'],
  ['POST', '/api/bookings/direct-from-offer'],
  ['POST', '/api/bookings/initiate-payment'],
  ['POST', '/api/bookings/confirm-online'],
  ['POST', '/api/bookings/waitlist'],
  ['DELETE', '/api/bookings/queue/queue-id'],
  ['PATCH', '/api/bookings/queue/queue-id/start'],
  ['DELETE', '/api/bookings/queue/queue-id/provider'],
  ['PATCH', '/api/bookings/queue/queue-id/complete'],
  ['POST', '/api/bookings/booking-id/dispute'],
  ['POST', '/api/bookings/booking-id/reports'],
  ['POST', '/api/bookings/booking-id/confirm'],
  ['POST', '/api/bookings/booking-id/completion-escalations'],
  ['POST', '/api/bookings/booking-id/cancel'],
  ['POST', '/api/bookings/cancellation-requests/request-id/escalate'],
  ['PATCH', '/api/bookings/cancellation-requests/request-id/respond'],
  ['PATCH', '/api/bookings/completed/completed-id/confirm'],
  ['POST', '/api/requests'],
  ['GET', '/api/requests'],
  ['GET', '/api/requests/mine'],
  ['PATCH', '/api/requests/request-id'],
  ['DELETE', '/api/requests/request-id'],
  ['POST', '/api/offers'],
  ['GET', '/api/offers/received'],
  ['GET', '/api/offers/mine'],
  ['PATCH', '/api/offers/offer-id/accept'],
  ['PATCH', '/api/offers/offer-id/reject'],
  ['GET', '/api/messages/conversations'],
  ['GET', '/api/messages/booking-id'],
  ['POST', '/api/messages/booking-id'],
  ['GET', '/api/notifications'],
  ['PATCH', '/api/notifications/read-all'],
  ['GET', '/api/transactions'],
  ['POST', '/api/reviews'],
  ['PATCH', '/api/reviews/review-id'],
  ['GET', '/api/users'],
  ['GET', '/api/users/me/account-deletion'],
  ['POST', '/api/users/me/account-deletion'],
  ['DELETE', '/api/users/me/account-deletion'],
  ['GET', '/api/ai/provider-summary/provider-id'],
  ['POST', '/api/ai/match-providers'],
  ['POST', '/api/upload/avatar'],
  ['POST', '/api/upload/image'],
  ['POST', '/api/upload/verification'],
  ['POST', '/api/upload/booking-evidence'],
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/audit-logs'],
  ['POST', '/api/admin/announcements'],
  ['PATCH', '/api/admin/users/user-id/suspend'],
  ['POST', '/api/admin/account-deletions/user-id/finalize'],
  ['GET', '/api/admin/verifications/verification-id/proofs/proof-id/access'],
  ['PATCH', '/api/admin/verifications/verification-id'],
  ['PATCH', '/api/admin/services/service-id/review'],
  ['GET', '/api/admin/categories'],
  ['PATCH', '/api/admin/categories/category-id'],
  ['PATCH', '/api/admin/categories/suggestions/suggestion-id'],
  ['GET', '/api/admin/reports/report-id/evidence/access'],
  ['PATCH', '/api/admin/reports/report-id/resolve'],
  ['PATCH', '/api/admin/reviews/review-id/moderation'],
  ['PATCH', '/api/admin/completion-escalations/escalation-id/resolve'],
  ['POST', '/api/admin/payments/reconciliation/reconciliation-id/retry'],
  ['POST', '/api/admin/bookings/booking-id/cancel'],
  ['PATCH', '/api/admin/cancellation-requests/request-id/resolve'],
  ['GET', '/api/admin/bookings/booking-id/messages'],
];

test('every Tier 0 protected HTTP route rejects a missing bearer token with 401', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const { port } = server.address() as AddressInfo;
  for (const [method, path] of protectedRoutes) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: method === 'GET' || method === 'DELETE' ? undefined : { 'Content-Type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });
    assert.equal(response.status, 401, `${method} ${path} must reject missing authentication`);
    const body = await response.json() as { success?: boolean };
    assert.equal(body.success, false, `${method} ${path} must return the standard failure envelope`);
  }
});

test('HTTP responses include correlation and baseline security headers', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const { port } = server.address() as AddressInfo;
  const suppliedRequestId = 'capstone-test-request-001';
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { 'X-Request-Id': suppliedRequestId },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), suppliedRequestId);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-powered-by'), null);
});
