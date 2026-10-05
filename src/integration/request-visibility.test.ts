import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'pg';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { createRequest, getMyRequests, listRequests } from '../services/requests.service';
import { submitOffer } from '../services/offers.service';
import { readPublicContent } from '../services/content-workspace.service';

test('public job visibility and database repair apply to every account', async t => {
  const schema = new URL(env.DATABASE_URL).searchParams.get('schema') || '';
  assert.match(schema, /^audit_20260924_[a-f0-9]{32}$/, 'Use the isolated audit runner; never insert fixtures in the application schema.');
  t.after(() => prisma.$disconnect());
  const suffix = randomUUID();
  const users = await Promise.all(['seeker-one', 'seeker-two', 'provider-one', 'provider-two', 'provider-three'].map(label => prisma.user.create({ data: {
    name: label, email: `${label}-${suffix}@example.test`, passwordHash: 'test-only-unusable-hash',
    phone: 'test-only', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED',
  } })));
  const [seekerOne, seekerTwo, providerOne, providerTwo, providerThree] = users;
  const category = await prisma.category.create({ data: { name: `Request visibility ${suffix}` } });
  const fields = { categoryId: category.id, title: 'Fix kitchen faucet leak', description: 'The faucet leaks under the sink and needs repair.', budgetMin: 350, budgetMax: 350, urgency: 'Flexible Schedule', paymentMethods: { cash: true, gcash: false } };
  const publicPosts = await Promise.all([seekerOne, seekerTwo].map(user => createRequest(user.id, fields)));
  const listing = await prisma.service.create({ data: {
    providerId: providerOne.id, categoryId: category.id, title: 'Fix faucets', titleNormalized: `fix faucets ${suffix}`,
    description: 'Repair leaking kitchen faucets.', price: 350, status: 'ACTIVE', isAvailable: true, priceType: 'FIXED', estimatedDurationMins: 60,
    paymentMethods: { cash: true, gcash: false },
  } });
  const inquiry = await prisma.serviceRequest.create({ data: {
    ...fields, seekerId: seekerOne.id, title: 'Private faucet listing inquiry',
    targetProviderId: providerOne.id, targetServiceId: listing.id,
  } });
  const inquiryBefore = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: inquiry.id } });
  const legacyIds = [randomUUID(), randomUUID(), randomUUID()];

  await t.test('migration repairs all provider-only records and preserves listing inquiries and lifecycle states', async () => {
    // Recreate pre-migration corruption only inside this disposable schema.
    const client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT current_schema() AS schema');
      assert.equal(current.rows[0].schema, schema);
      await client.query('ALTER TABLE "service_requests" DROP CONSTRAINT "service_requests_target_provider_requires_listing_check"');
      for (let i = 0; i < legacyIds.length; i++) {
        await client.query(`INSERT INTO "service_requests"
          ("id", "seekerId", "categoryId", "title", "description", "budgetMin", "budgetMax", "urgency", "status", "targetProviderId", "createdAt", "updatedAt")
          VALUES ($1,$2,$3,$4,$5,350,350,'Flexible Schedule',$6,$7,NOW(),NOW())`,
          [legacyIds[i], i === 1 ? seekerTwo.id : seekerOne.id, category.id, `Legacy public faucet job ${i}`, fields.description, i === 2 ? 'CLOSED' : 'OPEN', i === 1 ? providerTwo.id : providerOne.id]);
      }
      const sql = await readFile('prisma/migrations/20261004160000_public_request_visibility/migration.sql', 'utf8');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { await client.end(); }
    for (const id of legacyIds) {
      const row = await prisma.serviceRequest.findUniqueOrThrow({ where: { id } });
      assert.equal(row.targetProviderId, null);
      assert.equal(row.targetServiceId, null);
      assert.equal(row.status, id === legacyIds[2] ? 'CLOSED' : 'OPEN');
    }
    assert.deepEqual(await prisma.serviceRequest.findUniqueOrThrow({ where: { id: inquiry.id } }), inquiryBefore);
  });

  await t.test('new and repaired public jobs appear for their owners and three unrelated providers', async () => {
    for (const user of users) {
      const results = await listRequests(category.id, user.id);
      for (const post of [...publicPosts, ...legacyIds.slice(0, 2).map(id => ({ id }))]) {
        const row = results.find(item => item.id === post.id);
        assert.ok(row, `Public job ${post.id} missing for ${user.name}`);
        assert.equal(row.targetProviderId, null);
      }
      assert.ok(!results.some(item => item.id === legacyIds[2]), 'Paused job must stay hidden.');
      assert.equal(results.some(item => item.id === inquiry.id), user.id === seekerOne.id || user.id === providerOne.id);
    }
    const ownerRows = await getMyRequests(seekerTwo.id);
    assert.ok(ownerRows.some(item => item.id === legacyIds[1]));
    for (const post of publicPosts) {
      assert.equal(post.targetProviderId, null);
      assert.equal(post.targetServiceId, null);
    }
    assert.ok(await readPublicContent(prisma, 'SERVICE_REQUEST', legacyIds[0]), 'A public job remains available in admin content management.');
    assert.equal(await readPublicContent(prisma, 'SERVICE_REQUEST', inquiry.id), null, 'Private listing details must stay out of public content management.');
  });

  await t.test('multiple providers can offer on repaired posts, while owners cannot offer on their own jobs', async () => {
    const proposal = { requestId: legacyIds[0], offeredPrice: 350, estimatedDuration: 60, message: 'I can repair the faucet.' };
    for (const provider of [providerOne, providerTwo, providerThree]) {
      assert.equal((await submitOffer(provider.id, proposal)).status, 'PENDING');
    }
    await assert.rejects(submitOffer(seekerOne.id, proposal), /cannot.*yourself|own|self/i);
    await assert.rejects(submitOffer(providerTwo.id, { ...proposal, requestId: inquiry.id, serviceId: listing.id }), (error: any) => error.code === 'REQUEST_RESERVED');
  });

  await t.test('database guard prevents future provider-only corruption', async () => {
    await assert.rejects(prisma.serviceRequest.create({ data: {
      ...fields, seekerId: seekerTwo.id, title: 'Invalid assigned public post', targetProviderId: providerOne.id,
    } }), /service_requests_target_provider_requires_listing_check/);
  });
});
