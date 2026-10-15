import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { accountAccessDecision, requireVerification } from '../middlewares/auth.middleware';
import { getUserPermissions } from '../utils/permissions';

const approved = { role: 'user', emailVerified: true, verificationStatus: 'APPROVED', isActive: true, moderationStatus: 'ACTIVE' };

for (const verificationStatus of ['APPROVED', 'UNVERIFIED', 'PENDING_REVIEW', 'REJECTED']) {
  test(`suspension keeps browsing identity but rejects new transactions even with ${verificationStatus} residency`, () => {
    const user = { ...approved, moderationStatus: 'SUSPENDED', verificationStatus };
    assert.equal(accountAccessDecision(user), 'ALLOW');
    const permissions = getUserPermissions(user);
    assert.equal(permissions.canBrowse, true);
    for (const action of ['canTransact', 'canCreateListings', 'canBookServices', 'canAcceptBookings', 'canReview'] as const) assert.equal(permissions[action], false, action);
    let status = 200, code: unknown, allowed = false;
    const response = { status(value: number) { status = value; return this; }, json(body: { code: unknown }) { code = body.code; return this; } };
    requireVerification({ user } as unknown as Request, response as unknown as Response, () => { allowed = true; });
    assert.equal(status, 403);
    assert.equal(code, 'ACCOUNT_SUSPENDED');
    assert.equal(allowed, false);
  });
}

test('restoration re-enables an approved member but never bypasses missing residency verification', () => {
  assert.equal(getUserPermissions(approved).canTransact, true);
  assert.equal(getUserPermissions({ ...approved, moderationStatus: 'SUSPENDED' }).canTransact, false);
  assert.equal(getUserPermissions({ ...approved, verificationStatus: 'UNVERIFIED' }).canTransact, false);
  assert.equal(getUserPermissions({ ...approved, emailVerified: false }).canReview, false);
});
