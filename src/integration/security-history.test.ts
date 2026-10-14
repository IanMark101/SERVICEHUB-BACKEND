import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { loginUser, logoutUser, googleLoginUser, recoverSession } from '../services/auth.service';
import { googleLogin } from '../controllers/auth.controller';
import { listAdminAuditLogs } from '../controllers/admin/audit-log.controller';
import { resolveIpArea, type SecurityContext } from '../lib/security-context';
import { recordSecurityEvent, pruneSecurityHistory, securityHistoryCutoff } from '../services/security-history.service';

// Integration is deliberately confined to the fresh migration harness schema.
assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
const context: SecurityContext = { ipAddress: '8.8.8.8', ...resolveIpArea('8.8.8.8'), browser: 'Chrome', device: 'Windows', userAgent: 'Chrome/130 Windows', requestId: randomUUID() };
after(() => prisma.$disconnect());

test('security events persist across logout, support investigation and respect account deletion', async t => {
  const suffix = randomUUID(); const password = `fixture-password-${suffix}`;
  const user = await prisma.user.create({ data: { name: 'Security integration sample', email: `security-${suffix}@example.test`, passwordHash: await bcrypt.hash(password, 4), passwordState: 'SET', phone: '', location: 'Cordova' } });
  const admin = await prisma.user.create({ data: { name: 'Security integration admin', email: `admin-${suffix}@example.test`, passwordHash: 'unused-test-hash', phone: '', location: '', role: 'admin' } });

  const signedIn = await loginUser({ email: user.email, password }, context);
  const successful = await prisma.securityEvent.findFirstOrThrow({ where: { userId: user.id, action: 'SIGN_IN_SUCCESS' } });
  assert.equal(successful.method, 'PASSWORD'); assert.equal(successful.locationStatus, 'APPROXIMATE'); assert.ok(successful.country); assert.equal(successful.sessionReference?.length, 64);
  assert.ok(!JSON.stringify(successful).includes(password)); assert.ok(!JSON.stringify(successful).includes(signedIn.tokens.refreshToken));
  await recoverSession(signedIn.tokens.refreshToken); await recoverSession(signedIn.tokens.refreshToken);
  assert.equal(await prisma.securityEvent.count({ where: { userId: user.id, action: 'SIGN_IN_SUCCESS' } }), 1, 'cookie recovery must not create fake sign-ins');
  await assert.rejects(loginUser({ email: user.email, password: 'incorrect-password' }, context), { message: 'Invalid credentials' });
  await assert.rejects(loginUser({ email: `unknown-${suffix}@example.test`, password: 'incorrect-password' }, context), { message: 'Invalid credentials' });
  assert.equal(await prisma.securityEvent.count({ where: { userId: user.id, action: 'SIGN_IN_FAILED' } }), 1);
  assert.equal(await prisma.securityEvent.count({ where: { userId: null, action: 'SIGN_IN_FAILED' } }), 1);
  await logoutUser(signedIn.tokens.refreshToken, context);
  assert.equal(await prisma.refreshToken.count({ where: { userId: user.id } }), 0);
  const signedOut = await prisma.securityEvent.findFirstOrThrow({ where: { userId: user.id, action: 'SIGN_OUT' } });
  assert.equal(signedOut.sessionReference, successful.sessionReference);
  assert.equal(await prisma.securityEvent.count({ where: { userId: user.id } }), 3);

  let body: any; const headers: Record<string, string> = {};
  await listAdminAuditLogs({ query: { kind: 'security', search: user.email, action: 'SIGN_IN_SUCCESS' }, user: { id: admin.id } } as unknown as Request,
    { setHeader: (key: string, value: string) => { headers[key] = value; }, json: (value: any) => { body = value; } } as unknown as Response,
    error => { throw error; });
  assert.equal(body.pagination.total, 1); assert.equal(body.data[0].user.id, user.id); assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(await prisma.adminAuditLog.count({ where: { actorId: admin.id, action: 'USER_SECURITY_HISTORY_VIEWED' } }), 1);

  const old = await prisma.securityEvent.create({ data: { ...context, userId: user.id, action: 'SIGN_IN_SUCCESS', reason: 'Expired fixture', createdAt: new Date(securityHistoryCutoff().getTime() - 1000) } });
  await pruneSecurityHistory(); assert.equal(await prisma.securityEvent.findUnique({ where: { id: old.id } }), null);
  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.securityEvent.count({ where: { userId: user.id } }), 0, 'account purge must remove personal security history');
});

test('Google sign-in is logged and rejected Google tokens never persist', async t => {
  const clientId = env.GOOGLE_CLIENT_ID; env.GOOGLE_CLIENT_ID = 'security-integration-client';
  t.after(() => { env.GOOGLE_CLIENT_ID = clientId; });
  const suffix = randomUUID(); let reject = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ aud: env.GOOGLE_CLIENT_ID, iss: 'https://accounts.google.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, sub: `google-${suffix}`, email: `google-${suffix}@example.test`, name: 'Google integration sample' }), { status: reject ? 401 : 200 }));
  const result = await googleLoginUser('never-persist-this-google-token', context);
  const event = await prisma.securityEvent.findFirstOrThrow({ where: { userId: result.user.id } });
  assert.equal(event.action, 'SIGN_IN_SUCCESS'); assert.equal(event.method, 'GOOGLE'); assert.ok(!JSON.stringify(event).includes('never-persist-this-google-token'));
  reject = true;
  let rejected: any;
  await googleLogin({ body: { token: 'invalid-google-token' }, ip: '127.0.0.1', get: () => 'Safari/605 iPhone' } as unknown as Request,
    { locals: { requestId: 'google-rejected-fixture' } } as Response,
    error => { rejected = error; });
  assert.equal(rejected.status, 401);
  const failed = await prisma.securityEvent.findFirstOrThrow({ where: { requestId: 'google-rejected-fixture' } });
  assert.equal(failed.action, 'SIGN_IN_FAILED'); assert.equal(failed.method, 'GOOGLE'); assert.equal(failed.locationStatus, 'LOCAL_NETWORK');
  assert.ok(!JSON.stringify(failed).includes('invalid-google-token'));
  await recordSecurityEvent(context, result.user.id, 'OFFER_SENT', 'Sent an offer');
});
