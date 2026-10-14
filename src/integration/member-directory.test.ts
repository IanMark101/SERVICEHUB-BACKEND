import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import usersRoutes from '../routes/users.routes';
import authRoutes from '../routes/auth.routes';
import reviewsRoutes from '../routes/reviews.routes';
import aiRoutes from '../routes/ai.routes';
import adminRoutes from '../routes/admin.routes';

test('member discovery protects administrator identities without disabling account or investigation access', { timeout: 180000 }, async t => {
  // Refuse to insert any fixtures outside the disposable migration harness.
  const database = new URL(env.DATABASE_URL);
  assert.match(database.searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
  const suffix = randomUUID();
  const userIds: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/reviews', reviewsRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/admin', adminRoutes);
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.name === 'ZodError' ? 400 : error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });
  const makeUser = async (name: string, role = 'user') => {
    const user = await prisma.user.create({ data: {
      name: `${name} ${suffix}`, role, email: `private-${name}-${suffix}@example.test`,
      location: `City ${suffix}`, bio: `Public introduction ${suffix}`, phone: `fixture-${name}-${suffix}`,
      passwordHash: 'private-fixture-hash', emailVerified: true, verificationStatus: 'APPROVED',
    } });
    userIds.push(user.id); return user;
  };
  const admin = await makeUser('Administrator', 'admin');
  const otherAdmin = await makeUser('Staff', 'admin');
  const member = await makeUser('Member');
  const peer = await makeUser('Peer');
  const inactive = await makeUser('Inactive');
  const banned = await makeUser('Banned');
  const unverified = await makeUser('Unverified');
  await prisma.user.update({ where: { id: inactive.id }, data: { isActive: false } });
  await prisma.user.update({ where: { id: banned.id }, data: { moderationStatus: 'BANNED' } });
  await prisma.user.update({ where: { id: unverified.id }, data: { emailVerified: false } });
  const tokenFor = async (user: typeof member) => {
    const session = await prisma.refreshToken.create({ data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
    return jwt.sign({ sub: user.id, role: user.role, sid: session.id }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
  };
  const memberToken = await tokenFor(member), adminToken = await tokenFor(admin), unverifiedToken = await tokenFor(unverified);
  const call = async (path: string, token?: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };

  await t.test('member search requires authentication and excludes admin accounts and private email matching', async () => {
    assert.equal((await call('/users?search=Administrator')).status, 401);
    assert.equal((await call('/users?search=Member', unverifiedToken)).status, 403);
    for (const token of [memberToken, adminToken]) {
      const result = await call(`/users?search=${suffix}&limit=50`, token);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data.map((row: any) => row.id).sort(), [member.id, peer.id, unverified.id].sort());
      assert.equal(result.body.pagination.total, 3);
      for (const row of result.body.data) {
        assert.equal(row.role, 'user');
        for (const field of ['email', 'phone', 'passwordHash']) assert.equal(field in row, false);
      }
      assert.equal((await call(`/users?search=${encodeURIComponent(admin.name)}`, token)).body.pagination.total, 0);
      assert.equal((await call(`/users?search=${encodeURIComponent(member.email)}`, token)).body.pagination.total, 0);
      assert.equal((await call('/users?role=admin', token)).status, 400);
      assert.equal((await call('/users?role=admin&role=user', token)).status, 400);
    }
    const paginated = await call(`/users?search=${suffix}&page=2&limit=2`, memberToken);
    assert.equal(paginated.body.pagination.total, 3); assert.equal(paginated.body.data.length, 1);
    const byName = await call(`/users?search=${encodeURIComponent(peer.name.toUpperCase())}`, memberToken);
    assert.equal(byName.body.data[0].id, peer.id);
    assert.equal((await call('/users?search=Member&search=Administrator', memberToken)).status, 400);
  });

  await t.test('direct profile IDs and secondary profile APIs do not bypass admin visibility', async () => {
    const hidden = `/auth/profile/${admin.id}`;
    const missing = '/auth/profile/nonexistent-member-fixture';
    assert.equal((await call(hidden)).status, 401);
    assert.deepEqual(await call(hidden, memberToken), await call(missing, memberToken));
    for (const path of [
      `/auth/trust-history/${admin.id}`, `/reviews/provider/${admin.id}`,
      `/ai/provider-summary/${admin.id}`, `/ai/seeker-summary/${admin.id}`,
    ]) assert.equal((await call(path, memberToken)).status, 404, path);
    assert.equal((await call(`/reviews/provider/${admin.id}`)).status, 404, 'Anonymous review access must not expose admin profiles either');
    const profile = await call(`/auth/profile/${peer.id}`, memberToken);
    assert.equal(profile.status, 200); assert.equal(profile.body.data.name, peer.name);
    for (const field of ['email', 'phone', 'passwordHash']) assert.equal(field in profile.body.data, false);
    for (const path of [`/auth/trust-history/${peer.id}`, `/reviews/provider/${peer.id}`, `/ai/provider-summary/${peer.id}`, `/ai/seeker-summary/${peer.id}`]) {
      assert.equal((await call(path, memberToken)).status, 200, path);
    }
  });

  await t.test('admins retain their own profile/settings and protected investigation tools', async () => {
    assert.equal((await call('/auth/me', adminToken)).body.data.user.role, 'admin');
    assert.equal((await call(`/auth/profile/${admin.id}`, adminToken)).status, 200);
    assert.equal((await call(`/auth/profile/${otherAdmin.id}`, adminToken)).status, 404);
    assert.equal((await call('/auth/profile', adminToken, 'PUT', { bio: 'Updated private administrator account fixture.' })).status, 200);
    assert.equal((await call('/auth/trust-history', adminToken)).status, 200);
    assert.equal((await call(`/admin/users/${peer.id}`)).status, 401);
    assert.equal((await call(`/admin/users/${peer.id}`, memberToken)).status, 403);
    assert.equal((await call(`/admin/users/${admin.id}`, memberToken)).status, 403);
    for (const target of [peer, otherAdmin]) {
      const profile = await call(`/admin/users/${target.id}`, adminToken);
      assert.equal(profile.status, 200); assert.equal(profile.body.data.user.email, target.email);
    }
    assert.equal((await call(`/auth/trust-history/${peer.id}`, adminToken)).status, 200);
    assert.equal(await prisma.adminAuditLog.count({ where: { actorId: admin.id, action: 'USER_PROFILE_VIEWED' } }), 2);
  });
});
