import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTrustEventInTransaction } from '../services/trust.service';

test('correction retries bind the operation to its original event, even with equal amounts and reasons', async () => {
  const input = { userId: 'member', actorAdminId: 'admin', delta: -3, requestedDelta: -3,
    eventKey: 'manual-trust:admin:operation', reason: 'Documented correction of an original completion.', reversesEventId: 'original-1' };
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => ({ trustScore: 50 }), update: async () => { throw new Error('A retry must not mutate the score'); } },
    trustScoreEvent: { findUnique: async () => ({ id: 'correction', ...input }) },
  };
  assert.deepEqual(await applyTrustEventInTransaction(tx as never, input), { applied: false });
  await assert.rejects(applyTrustEventInTransaction(tx as never, { ...input, reversesEventId: 'original-2' }),
    (error: unknown) => (error as { status: number; code: string }).status === 409 && (error as { code: string }).code === 'TRUST_OPERATION_CONFLICT');
});
