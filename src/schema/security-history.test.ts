import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { normalizeClientIp, resolveIpArea, securityContext, sessionReference, describeClient, type SecurityContext } from '../lib/security-context';
import { recordSecurityEvent, securityEventData, securityHistoryCutoff } from '../services/security-history.service';
import { AuditHistoryQuery, auditDateRange } from './audit-history.schema';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { loginUser, logoutUser } from '../services/auth.service';
import { listAdminAuditLogs } from '../controllers/admin/audit-log.controller';
import { securityActivity } from '../middlewares/securityActivity.middleware';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

const context: SecurityContext = { ipAddress: '203.0.113.10', locationStatus: 'UNAVAILABLE', city: null, region: null, country: null, browser: 'Chrome', device: 'Windows', userAgent: 'Chrome/test Windows', requestId: 'request-reference' };
function stub(t: TestContext, model: 'user' | 'securityEvent' | 'refreshToken' | 'adminAuditLog', method: string, implementation: (...args: any[]) => Promise<any>) {
  const delegate = prisma[model] as unknown as Record<string, unknown>;
  const original = delegate[method]; delegate[method] = implementation;
  t.after(() => { delegate[method] = original; });
}

test('normalizes valid IPv4/IPv6 and rejects injected or malformed addresses', () => {
  assert.equal(normalizeClientIp('::ffff:192.168.1.1'), '192.168.1.1');
  assert.equal(normalizeClientIp('2001:DB8::1'), '2001:db8::1');
  for (const invalid of ['8.8.8.8, 1.1.1.1', '8.8.8.8\r\nx:evil', 'not-an-ip', '1.2.3.4:80']) assert.equal(normalizeClientIp(invalid), null);
});

test('private and local networks never get a guessed city or call the IP database', () => {
  const lookup = () => { throw new Error('Local addresses must not be looked up'); };
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.1.1', '192.168.1.1', '100.64.1.1', '::1', 'fc12::1', 'fe80::1', '::ffff:c0a8:101']) {
    assert.deepEqual(resolveIpArea(ip, lookup), { locationStatus: 'LOCAL_NETWORK', city: null, region: null, country: null });
  }
});

test('keeps only a coarse IP area, never database coordinates or a profile location', () => {
  const area = resolveIpArea('8.8.8.8', () => ({ country: 'PH', region: 'CEB', city: 'Cebu', ll: [10.3, 123.9], range: [1, 2], area: 50, eu: '0', metro: 0, timezone: 'Asia/Manila' }));
  assert.deepEqual(area, { locationStatus: 'APPROXIMATE', country: 'PH', region: 'CEB', city: 'Cebu' });
  assert.equal(resolveIpArea('8.8.8.8', () => null).locationStatus, 'UNAVAILABLE');
  assert.equal(resolveIpArea('8.8.8.8', () => { throw new Error('Unavailable'); }).locationStatus, 'UNAVAILABLE');
});

test('resolves client IP only through Express approved proxy configuration', async t => {
  const app = express(); app.set('trust proxy', false);
  app.get('/', (req, res) => res.json(securityContext(req, res)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}`, { headers: { 'X-Forwarded-For': '8.8.8.8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36 Edg/130' } });
  const untrusted = await response.json() as SecurityContext;
  assert.equal(untrusted.ipAddress, '127.0.0.1'); assert.equal(untrusted.locationStatus, 'LOCAL_NETWORK'); assert.equal(untrusted.browser, 'Microsoft Edge');
  app.set('trust proxy', ['loopback']);
  const trusted = await (await fetch(`http://127.0.0.1:${port}`, { headers: { 'X-Forwarded-For': '8.8.8.8' } })).json() as SecurityContext;
  assert.equal(trusted.ipAddress, '8.8.8.8');
});

test('session correlation is stable and contains no usable token or raw session ID', () => {
  const first = securityEventData(context, 'user-1', 'SIGN_IN_SUCCESS', 'Authentication succeeded', 'PASSWORD', 'session-secret');
  const later = securityEventData(context, 'user-1', 'BOOKING_REQUESTED', 'Requested a booking', undefined, 'session-secret');
  assert.equal(first.sessionReference, later.sessionReference);
  assert.match(first.sessionReference!, /^[a-f0-9]{64}$/); assert.notEqual(first.sessionReference, 'session-secret');
  assert.equal(sessionReference(), null);
  assert.equal(describeClient('Mozilla/5.0 (iPhone) AppleWebKit Safari/605').device, 'iPhone');
});

test('successful password sign-in records its event in the session transaction', async t => {
  const user = { id: 'user-1', name: 'Test', email: 'test@example.test', passwordHash: 'test-hash', passwordState: 'SET', isActive: true, moderationStatus: 'ACTIVE', role: 'user' };
  stub(t, 'user', 'findUnique', async () => user);
  t.mock.method(bcrypt, 'compare', async () => true);
  const events: any[] = [];
  const originalTransaction = prisma.$transaction;
  t.after(() => { prisma.$transaction = originalTransaction; });
  prisma.$transaction = (async (work: any) => work({
    $executeRaw: async () => 1,
    user: { findUnique: async () => user },
    refreshToken: { create: async () => ({ id: 'test-session' }), update: async () => ({}) },
    securityEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
  })) as typeof prisma.$transaction;
  const signedIn = await loginUser({ email: user.email, password: 'test-password' }, context);
  assert.equal(events.length, 1); assert.equal(events[0].action, 'SIGN_IN_SUCCESS'); assert.equal(events[0].sessionReference, sessionReference('test-session'));
  assert.equal((jwt.verify(signedIn.tokens.accessToken, env.JWT_ACCESS_SECRET) as jwt.JwtPayload).sid, 'test-session');
  assert.ok(!JSON.stringify(events).includes('test-password')); assert.ok(!JSON.stringify(events).includes(signedIn.tokens.refreshToken));
});

test('known and unknown failed passwords keep the same public error and never store submitted credentials', async t => {
  const events: any[] = []; let found = true;
  stub(t, 'user', 'findUnique', async () => found ? { id: 'known-user', passwordState: 'SET', passwordHash: 'hash' } : null);
  stub(t, 'securityEvent', 'create', async ({ data }) => { events.push(data); return data; });
  t.mock.method(bcrypt, 'compare', async () => false);
  await assert.rejects(loginUser({ email: 'known@example.test', password: 'never-log-this' }, context), { message: 'Invalid credentials' });
  found = false;
  await assert.rejects(loginUser({ email: 'unknown@example.test', password: 'never-log-this' }, context), { message: 'Invalid credentials' });
  assert.deepEqual(events.map(event => event.userId), ['known-user', null]);
  assert.ok(!JSON.stringify(events).includes('never-log-this')); assert.ok(!JSON.stringify(events).includes('@example.test'));
});

test('a failed audit write cannot turn denied authentication into access', async t => {
  stub(t, 'securityEvent', 'create', async () => { throw new Error('Storage unavailable'); });
  t.mock.method(console, 'error', () => {});
  await recordSecurityEvent(context, null, 'SIGN_IN_FAILED', 'Credentials rejected', 'PASSWORD');
});

test('explicit sign-out preserves a durable event with the original session reference', async t => {
  const token = jwt.sign({ sub: 'user-1', sid: 'test-session' }, env.JWT_REFRESH_SECRET);
  const events: any[] = [];
  stub(t, 'refreshToken', 'findFirst', async () => ({ id: 'test-session', userId: 'user-1' }));
  stub(t, 'refreshToken', 'deleteMany', async () => ({ count: 1 }));
  stub(t, 'securityEvent', 'create', async ({ data }) => { events.push(data); return data; });
  await logoutUser(token, context);
  assert.equal(events[0].action, 'SIGN_OUT'); assert.equal(events[0].sessionReference, sessionReference('test-session'));
  assert.ok(!JSON.stringify(events).includes(token));
});

test('security filters validate paging and dates and enforce retention', () => {
  for (const input of [{ limit: '9999' }, { page: '-1' }, { kind: 'private' }, { from: '2026-02-31' }, { from: '2026-10-13', to: '2026-10-12' }]) assert.equal(AuditHistoryQuery.safeParse(input).success, false);
  const now = new Date('2026-10-13T12:00:00Z');
  const query = AuditHistoryQuery.parse({ kind: 'security', from: '2020-01-01', to: '2026-10-13' });
  assert.equal(auditDateRange(query, now).gte?.toISOString(), securityHistoryCutoff(now).toISOString());
  assert.equal(auditDateRange(query, now).lt?.toISOString(), '2026-10-14T00:00:00.000Z');
});

test('admin security history access is audited, paginated, filtered and never cached', async t => {
  let accessRecorded = false; let captured: any;
  stub(t, 'adminAuditLog', 'create', async () => { accessRecorded = true; return {}; });
  stub(t, 'securityEvent', 'findMany', async args => { assert.equal(accessRecorded, true); captured = args; return []; });
  stub(t, 'securityEvent', 'count', async () => 50);
  const headers: Record<string, string> = {}; let body: any;
  await listAdminAuditLogs({ query: { kind: 'security', search: 'Test', action: 'SIGN_IN_FAILED', page: '2', limit: '20' }, user: { id: 'admin-1' } } as unknown as Request,
    { setHeader: (key: string, value: string) => { headers[key] = value; }, json: (value: any) => { body = value; } } as unknown as Response,
    error => { throw error; });
  assert.equal(headers['Cache-Control'], 'no-store'); assert.equal(captured.skip, 20); assert.equal(captured.take, 20);
  assert.equal(captured.where.action, 'SIGN_IN_FAILED'); assert.ok(captured.where.OR.length >= 4); assert.equal(body.pagination.totalPages, 3);
});

test('successful marketplace writes correlate with sign-in sessions; rejected writes do not', async t => {
  const events: any[] = [];
  stub(t, 'securityEvent', 'create', async ({ data }) => { events.push(data); return data; });
  for (const statusCode of [201, 409]) {
    const req = { method: 'POST', path: '/api/services', ip: '127.0.0.1', get: () => 'Chrome/130 Windows', user: { id: 'user-1' }, sessionId: 'test-session' } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { statusCode, locals: {} }) as unknown as Response;
    securityActivity(req, res, () => {}); res.emit('finish'); await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(events.length, 1); assert.equal(events[0].action, 'SERVICE_PUBLISHED'); assert.equal(events[0].sessionReference, sessionReference('test-session'));
});
