import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';

test('verification decisions preserve resident messages and use private notification destinations', async t => {
  // Exercise the service with an in-memory transaction. No real database records are used.
  let stored: Record<string, unknown> = {};
  let notification: Record<string, unknown> = {};
  const updates: Array<Record<string, unknown>> = [];
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
    user: { update: async (query: { data: Record<string, unknown> }) => { updates.push(query.data); }, findUnique: async () => ({ trustScore: 55 }) },
    trustScoreEvent: { findUnique: async () => ({ id: 'existing-trust-event' }) },
    notification: { create: async (query: { data: Record<string, unknown> }) => { notification = query.data; } },
    adminAuditLog: { create: async () => ({}) },
  };
  const singleton = globalThis as unknown as { prisma?: PrismaClient };
  const previous = singleton.prisma;
  singleton.prisma = { ...fake, $transaction: async (run: (tx: typeof fake) => unknown) => run(fake) } as unknown as PrismaClient;
  t.after(() => { singleton.prisma = previous; });
  const { reviewVerification, getVerificationStatus } = await import('../services/verification.service');

  for (const approve of [true, false]) {
    const message = approve ? '  Your address was confirmed.\nThank you for your submission.  ' : '  Provide a document showing your current address.  ';
    await reviewVerification('submission', 'admin', approve, message);
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
