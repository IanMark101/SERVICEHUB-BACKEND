import test from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import { allowedReportPenalties, checkReportPenalty } from '../services/report-penalty-policy';
import { AdminMessagesQuery } from './admin-messages.schema';

const account = { id: 'participant', role: 'user', isActive: true, deactivatedAt: null, moderationStatus: 'ACTIVE' };
test('case penalties cannot reactivate accounts, punish admins, or weaken stronger restrictions', () => {
  for (const target of [null, { ...account, role: 'admin' }, { ...account, isActive: false }, { ...account, deactivatedAt: new Date() }]) assert.deepEqual(allowedReportPenalties(target), ['none']);
  assert.deepEqual(allowedReportPenalties(account, account.id), ['none']);
  assert.ok(!allowedReportPenalties({ ...account, moderationStatus: 'BANNED' }).includes('suspend'));
  assert.ok(!allowedReportPenalties({ ...account, moderationStatus: 'BANNED' }).includes('ban'));
  assert.ok(!allowedReportPenalties({ ...account, moderationStatus: 'SUSPENDED' }).includes('suspend'));
  assert.ok(allowedReportPenalties({ ...account, moderationStatus: 'SUSPENDED' }).includes('ban'));
});
test('changed account restrictions do not strand an already claimed booking resolution', async () => {
  const tx = { $executeRaw: async () => 0, user: { findUnique: async () => ({ ...account, moderationStatus: 'BANNED' }) } } as unknown as Prisma.TransactionClient;
  await assert.rejects(checkReportPenalty(tx, account.id, 'admin', 'suspend'), { code: 'INVALID_REPORT_PENALTY' });
  const result = await checkReportPenalty(tx, account.id, 'admin', 'suspend', { resuming: true });
  assert.equal(result.penalty, 'none');
  assert.match(result.note || '', /restrictions were preserved/);
});
test('suspension checks outstanding jobs before a decision is persisted and after payment finalizes', async () => {
  const tx = { $executeRaw: async () => 0, user: { findUnique: async () => account }, booking: { count: async () => 2 } } as unknown as Prisma.TransactionClient;
  for (const resuming of [false, true]) await assert.rejects(checkReportPenalty(tx, account.id, 'admin', 'suspend', { resuming }), { code: 'SUSPENSION_BOOKINGS_BLOCKED' });
});
test('admin conversation pages reject unsafe page sizes and malformed cursors', () => {
  assert.deepEqual(AdminMessagesQuery.parse({}), { limit: 50 });
  for (const limit of [0, 51, 'NaN', 2.5]) assert.equal(AdminMessagesQuery.safeParse({ limit }).success, false);
  assert.equal(AdminMessagesQuery.safeParse({ before: '' }).success, false);
  assert.equal(AdminMessagesQuery.safeParse({ before: 'message-id', limit: '20' }).success, true);
});
