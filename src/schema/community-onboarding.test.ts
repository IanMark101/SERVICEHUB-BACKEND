import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { UpdateOnboardingStatusSchema } from './users.schema';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('onboarding accepts only terminal user choices', () => {
  assert.equal(UpdateOnboardingStatusSchema.parse({ status: 'COMPLETED' }).status, 'COMPLETED');
  assert.equal(UpdateOnboardingStatusSchema.parse({ status: 'SKIPPED' }).status, 'SKIPPED');
  assert.equal(UpdateOnboardingStatusSchema.safeParse({ status: 'PENDING' }).success, false);
  assert.equal(UpdateOnboardingStatusSchema.safeParse({ status: 'COMPLETED', userId: 'other-user' }).success, false);
});

test('onboarding preference is protected and scoped to the authenticated user', () => {
  const routes = source('../routes/users.routes.ts');
  const controller = source('../controllers/users.controller.ts');
  assert.match(routes, /router\.patch\("\/me\/onboarding", requireAuth, requireMarketplaceUser, updateOnboardingStatus\)/);
  assert.match(controller, /\(req as AuthenticatedRequest\)\.user\.id/);
  assert.doesNotMatch(controller, /req\.body\.userId/);
});

test('onboarding migration preserves existing users and prompts new users', () => {
  const migration = source('../../prisma/migrations/20260909120000_add_user_onboarding_status/migration.sql');
  assert.match(migration, /DEFAULT 'COMPLETED'/);
  assert.match(migration, /SET DEFAULT 'PENDING'/);
});

test('community recent content uses approval dates and public field selection', () => {
  const community = source('../controllers/community.controller.ts');
  const services = source('../services/services.service.ts');
  assert.match(community, /RECENT_CONTENT_WINDOW_DAYS = 30/);
  assert.match(community, /recentServices:/);
  assert.match(services, /reviewedAt: \{ not: null/);
  assert.match(services, /orderBy: \{ reviewedAt: "desc" \}/);
  assert.match(services, /select: \{[\s\S]*id: true,[\s\S]*provider:/);
});
