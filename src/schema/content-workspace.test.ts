import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentDecisionSchema, ContentWorkspaceQuery } from './content-workspace.schema';

test('content decisions require a deliberate action, a useful reason, and no unknown fields', () => {
  assert.equal(ContentDecisionSchema.safeParse({ resolution: 'Reviewed the content.' }).success, false);
  assert.equal(ContentDecisionSchema.safeParse({ decision: 'KEEP', resolution: 'short' }).success, false);
  assert.equal(ContentDecisionSchema.safeParse({ decision: 'KEEP', resolution: 'Reviewed the content.', ban: true }).success, false);
  assert.equal(ContentDecisionSchema.safeParse({ decision: 'KEEP', resolution: 'Reviewed the content.' }).success, true);
});
test('keeping, restoring, or sending guidance cannot punish an account', () => {
  for (const decision of ['KEEP','RESTORE','GUIDANCE']) for (const penalty of ['warn','suspend','ban']) {
    assert.equal(ContentDecisionSchema.safeParse({ decision, penalty, resolution: 'Reviewed the content.', expectedUpdatedAt: new Date().toISOString(), expectedOwnerStatus: 'ACTIVE' }).success, false);
  }
});
test('changing content or punishing its owner requires current reviewed versions', () => {
  for (const decision of ['REMOVE','RESTORE']) assert.equal(ContentDecisionSchema.safeParse({ decision, resolution: 'Reviewed the content.' }).success, false);
  const base = { decision: 'KEEP_REMOVED', penalty: 'ban', resolution: 'Repeated confirmed violation.' };
  assert.equal(ContentDecisionSchema.safeParse({ ...base, expectedOwnerStatus: 'ACTIVE' }).success, false);
  assert.equal(ContentDecisionSchema.safeParse({ ...base, expectedUpdatedAt: new Date().toISOString() }).success, false);
  assert.equal(ContentDecisionSchema.safeParse({ ...base, expectedUpdatedAt: new Date().toISOString(), expectedOwnerStatus: 'ACTIVE' }).success, true);
});
test('content filters and suspensions have safe limits', () => {
  assert.equal(ContentWorkspaceQuery.safeParse({ page: -1 }).success, false);
  assert.equal(ContentWorkspaceQuery.safeParse({ limit: 5000 }).success, false);
  assert.equal(ContentWorkspaceQuery.safeParse({ contentType: 'PRIVATE_BOOKING' }).success, false);
  assert.equal(ContentWorkspaceQuery.safeParse({ contentType: 'SERVICE_REQUEST', caseType: 'APPEAL', status: 'RESOLVED' }).success, true);
  for (const suspensionDays of [0,31,1.5]) assert.equal(ContentDecisionSchema.safeParse({ decision: 'REMOVE', resolution: 'Confirmed violation.', expectedUpdatedAt: new Date().toISOString(), suspensionDays }).success, false);
});
