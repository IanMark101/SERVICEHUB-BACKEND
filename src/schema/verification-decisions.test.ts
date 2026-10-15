import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

test('verification decisions preserve resident messages and use private notification destinations', async t => {
  // Exercise the service with an in-memory transaction. No real database records are used.
  let stored: Record<string, unknown> = {};
  let notification: Record<string, unknown> = {};
  const updates: Array<Record<string, unknown>> = [];
  const administrator = { id: 'admin', name: 'Administrator fixture', role: 'admin', isActive: true, emailVerified: true, moderationStatus: 'ACTIVE', verificationStatus: 'UNVERIFIED' };
  const fake = {
    $executeRaw: async () => 0, $queryRaw: async () => [],
    serviceVerification: {
      findUnique: async () => ({ id: 'submission', userId: 'resident', user: { verificationStatus: 'PENDING_REVIEW' } }),
      findFirst: async (query: { include?: unknown }) => query.include
        ? { ...stored, proofs: [{ id: 'proof', storageKey: 'private-document-key', fileUrl: 'private-document-url' }] }
        : { id: 'submission' },
      updateMany: async (query: { where: { id: unknown }; data: Record<string, unknown> }) => {
        if (query.where.id === 'submission') stored = { id: 'submission', userId: 'resident', ...query.data };
        return { count: 1 };
      },
    },
    user: {
      update: async (query: { where: { id: string }; data: Record<string, unknown> }) => {
        assert.equal(query.where.id, 'resident', 'A verification decision must only update its applicant');
        updates.push(query.data);
      },
      findUnique: async (query: { where: { id: string } }) => query.where.id === 'admin' ? administrator : { trustScore: 55 },
    },
    refreshToken: {
      findUnique: async () => ({ id: 'admin-session', userId: 'admin', expiresAt: new Date(Date.now() + 300_000) }),
      deleteMany: async () => { throw new Error('Verification must not revoke authentication sessions'); },
      updateMany: async () => { throw new Error('Verification and reload recovery must not rotate authentication sessions'); },
    },
    trustScoreEvent: { findUnique: async () => ({ id: 'existing-trust-event' }) },
    notification: { create: async (query: { data: Record<string, unknown> }) => { notification = query.data; } },
    adminAuditLog: { create: async () => ({}) },
  };
  const singleton = globalThis as unknown as { prisma?: PrismaClient };
  const previous = singleton.prisma;
  singleton.prisma = { ...fake, $transaction: async (run: (tx: typeof fake) => unknown) => run(fake) } as unknown as PrismaClient;
  t.after(() => { singleton.prisma = previous; });
  const { reviewVerification, getVerificationStatus } = await import('../services/verification.service');
  const { recoverSession } = await import('../services/auth.service');
  const { env } = await import('../config/env');
  const adminCookie = jwt.sign({ sub: 'admin', sid: 'admin-session' }, env.JWT_REFRESH_SECRET, { expiresIn: '5m' });

  for (const approve of [true, false]) {
    const message = approve ? '  Your address was confirmed.\nThank you for your submission.  ' : '  Provide a document showing your current address.  ';
    await reviewVerification('submission', 'admin', approve, message);
    const restored = await recoverSession(adminCookie);
    assert.equal(restored.user.id, 'admin');
    assert.equal(restored.user.role, 'admin');
    assert.equal((jwt.verify(restored.accessToken, env.JWT_ACCESS_SECRET) as jwt.JwtPayload).sid, 'admin-session');
    assert.equal(stored.adminNotes, message.trim());
    assert.ok(stored.reviewedAt instanceof Date);
    assert.equal(notification.userId, 'resident');
    assert.equal(notification.link, '/account/settings#verification');
    assert.equal(notification.title, approve ? 'Verification Approved' : 'Verification Rejected');
    assert.equal(updates.at(-1)?.verificationStatus, approve ? 'APPROVED' : 'REJECTED');
    const status = await getVerificationStatus('resident');
    assert.equal(status?.adminNotes, message.trim());
    assert.equal(status?.proofs[0]?.storageKey, undefined);
    assert.equal(status?.proofs[0]?.fileUrl, undefined);
  }
  await reviewVerification('submission', 'admin', true, '   ');
  assert.equal(stored.adminNotes, null);
  assert.doesNotMatch(String(notification.body), /admin message/);
});
