import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { updateOwnGCashNumber } from '../services/auth/gcash-number.service';
import { toPublicUser } from '../services/auth/authentication.service';

assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
after(() => prisma.$disconnect());

test('GCash number stays private, separate from contact, and persists across sessions', async t => {
  const tag = randomUUID();
  const makeUser = (name: string, role = 'user') => prisma.user.create({ data: { name, email: `${name}-${tag}@example.test`, passwordHash: 'unused', phone: '09911111111', location: 'Cordova', role, emailVerified: true, verificationStatus: 'APPROVED' } });
  const [owner, other, admin] = await Promise.all([makeUser('Owner'), makeUser('Other'), makeUser('Admin', 'admin')]);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  const makeSession = async (user: typeof owner) => {
    const session = await prisma.refreshToken.create({ data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 120_000) } });
    const token = jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '2m' });
    return { id: session.id, token };
  };
  let session = await makeSession(owner);
  const call = (path: string, method = 'GET', payload?: unknown, token = session.token) => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(payload !== undefined && { body: JSON.stringify(payload) }) });
  try {
    await t.test('endpoint requires an active signed-in user and starts empty without copying phone', async () => {
      assert.equal((await fetch(`${base}/auth/gcash-number`)).status, 401);
      assert.equal((await call('/auth/gcash-number', 'PUT', { gcashNumber: '09123456789' }, (await makeSession(admin)).token)).status, 403);
      const response = await call('/auth/gcash-number');
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await response.json() as any).data, { gcashNumber: null });
    });
    await t.test('save normalizes the wallet number without changing contact or exposing it publicly', async () => {
      const response = await call('/auth/gcash-number', 'PUT', { gcashNumber: '+63 912-345-6789' });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await response.json() as any).data, { gcashNumber: '09123456789' });
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
      assert.equal(stored.phone, owner.phone); assert.equal(stored.gcashNumber, '09123456789');
      assert.equal('gcashNumber' in toPublicUser(stored), false);
      const publicProfile = await call(`/auth/profile/${owner.id}`, 'GET', undefined, (await makeSession(other)).token);
      assert.equal(publicProfile.status, 200); assert.ok(!(await publicProfile.text()).includes('09123456789'));
      const selfProfile = await call('/auth/me'); assert.equal(selfProfile.status, 200);
      assert.ok(!(await selfProfile.text()).includes('gcashNumber'));
    });
    await t.test('owner cannot be supplied; private number and contact updates cannot be mixed', async () => {
      for (const payload of [{ gcashNumber: '08123456789' }, { gcashNumber: '09123456789', userId: other.id }, { gcashNumber: '09123456789', phone: '09111111111' }]) {
        assert.equal((await call('/auth/gcash-number', 'PUT', payload)).status, 400);
      }
      const otherResponse = await call('/auth/gcash-number', 'GET', undefined, (await makeSession(other)).token);
      assert.deepEqual((await otherResponse.json() as any).data, { gcashNumber: null });
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).phone, owner.phone);
      await assert.rejects(prisma.user.update({ where: { id: owner.id }, data: { gcashNumber: 'invalid' } }));
    });
    await t.test('fresh sessions retain the number; revoked sessions cannot read or change it', async () => {
      const previous = session;
      await prisma.refreshToken.deleteMany({ where: { userId: owner.id } });
      assert.equal((await call('/auth/gcash-number')).status, 401);
      await assert.rejects(updateOwnGCashNumber(owner.id, previous.id, { gcashNumber: null }), /session expired/);
      session = await makeSession(owner);
      assert.deepEqual((await (await call('/auth/gcash-number')).json() as any).data, { gcashNumber: '09123456789' });
      const updated = await call('/auth/gcash-number', 'PUT', { gcashNumber: '09987654321' }); assert.equal(updated.status, 200);
      assert.deepEqual((await updated.json() as any).data, { gcashNumber: '09987654321' });
    });
    await t.test('removal is idempotent and deactivated accounts cannot mutate it', async () => {
      for (let i = 0; i < 2; i++) {
        const response = await call('/auth/gcash-number', 'PUT', { gcashNumber: null }); assert.equal(response.status, 200);
        assert.deepEqual((await response.json() as any).data, { gcashNumber: null });
      }
      await prisma.user.update({ where: { id: owner.id }, data: { deactivatedAt: new Date(), isActive: false } });
      assert.equal((await call('/auth/gcash-number', 'PUT', { gcashNumber: '09123456789' })).status, 403);
      await assert.rejects(updateOwnGCashNumber(owner.id, session.id, { gcashNumber: '09123456789' }), /eligible/);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).phone, owner.phone);
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
