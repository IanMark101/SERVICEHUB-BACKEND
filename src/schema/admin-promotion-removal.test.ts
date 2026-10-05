import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import express from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

test('removed promotion endpoint cannot grant administrator access', async t => {
  // In-memory identities exercise the actual authorization/router chain without
  // creating database accounts, credentials, sessions, or changing real roles.
  const actor = { id: 'promotion-removal-actor', role: 'admin', isActive: true, moderationStatus: 'ACTIVE', deactivatedAt: null };
  const sessionId = 'promotion-removal-session';
  const update = t.mock.fn(async () => { throw new Error('Unexpected user mutation'); });
  const transaction = t.mock.fn(async () => { throw new Error('Unexpected database transaction'); });
  const database = {
    refreshToken: { findUnique: async () => ({ id: sessionId, userId: actor.id, expiresAt: new Date(Date.now() + 60000) }) },
    user: { findUnique: async () => ({ ...actor }), update },
    $transaction: transaction,
  };
  // The Prisma singleton accepts a cached adapter. Install a test-only adapter
  // before importing routes so no real database connection is made.
  const singleton = globalThis as unknown as { prisma?: unknown };
  const previous = singleton.prisma;
  singleton.prisma = database;
  t.after(() => { if (previous === undefined) delete singleton.prisma; else singleton.prisma = previous; });
  const { default: adminRoutes } = await import('../routes/admin.routes.ts');

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = (server.address() as { port: number }).port;
  const bearer = jwt.sign({ sub: actor.id, sid: sessionId, role: 'admin' }, env.JWT_ACCESS_SECRET, { expiresIn: '1m' });
  const request = (token?: string) => fetch(`http://127.0.0.1:${port}/api/admin/users/target-user/promote`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ reason: 'Legacy promotion request', currentPassword: 'unused-test-password', role: 'admin' }),
  });

  const administrator = await request(bearer);
  assert.equal(administrator.status, 404, 'Even an authenticated administrator has no promotion endpoint');
  await administrator.text();
  actor.role = 'user';
  const standardUser = await request(bearer);
  assert.equal(standardUser.status, 403, 'The database role, not the token role, controls admin authorization');
  await standardUser.text();
  const anonymous = await request();
  assert.equal(anonymous.status, 401);
  await anonymous.text();
  assert.equal(update.mock.callCount(), 0);
  assert.equal(transaction.mock.callCount(), 0);
});
