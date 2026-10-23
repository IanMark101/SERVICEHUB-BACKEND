import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { env } from '../config/env';

test('existing provider rollout grants one full trial, preserves active Pro and never deletes excess listings', async () => {
  const parent = new URL(env.DATABASE_URL);
  assert.match(parent.searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
  const schema = `servicehub_migration_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^servicehub_migration_test_[a-f0-9]{32}$/);
  const client = new Client({ connectionString: parent.toString(), connectionTimeoutMillis: 20000 });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE','PRO');
      CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE','EXPIRED','CANCELLED');
      CREATE TYPE "ServiceStatus" AS ENUM ('ACTIVE','INACTIVE');
      CREATE TABLE users (id text PRIMARY KEY, role text, "subscriptionPlan" "SubscriptionPlan", "subscriptionStatus" "SubscriptionStatus", "subscriptionExpiresAt" timestamp(3));
      CREATE TABLE services (id text PRIMARY KEY, "providerId" text, status "ServiceStatus", "isAvailable" boolean, "publishedAt" timestamp(3));
      CREATE TABLE offers ("providerId" text); CREATE TABLE bookings ("providerId" text);
      CREATE TABLE subscription_payments (id text PRIMARY KEY);
      INSERT INTO users VALUES ('free','user','FREE','ACTIVE',NULL),('pro','user','PRO','ACTIVE',CURRENT_TIMESTAMP+INTERVAL '20 days'),('expired','user','PRO','EXPIRED',CURRENT_TIMESTAMP-INTERVAL '10 days'),('customer','user','FREE','ACTIVE',NULL);
      INSERT INTO services SELECT prefix||n, prefix, 'ACTIVE', true, CURRENT_TIMESTAMP+n*INTERVAL '1 minute' FROM unnest(ARRAY['free','pro','expired']) prefix CROSS JOIN generate_series(1,4) n;
    `);
    const before = await client.query(`SELECT "subscriptionExpiresAt" FROM users WHERE id='pro'`);
    const sql = await readFile('prisma/migrations/20261022090000_three_provider_memberships/migration.sql', 'utf8');
    await client.query(sql);
    const { rows } = await client.query(`SELECT *,EXTRACT(EPOCH FROM ("freePlanExpiresAt"-"freePlanStartedAt"))::int AS duration FROM users ORDER BY id`);
    for (const id of ['free','pro','expired']) assert.equal(rows.find(row => row.id === id).duration, 30*86400);
    assert.equal(rows.find(row => row.id === 'customer').freePlanStartedAt, null);
    assert.equal(rows.find(row => row.id === 'pro').subscriptionPlan, 'PRO');
    assert.equal(rows.find(row => row.id === 'pro').subscriptionExpiresAt.getTime(), before.rows[0].subscriptionExpiresAt.getTime());
    assert.equal(rows.find(row => row.id === 'expired').subscriptionPlan, 'FREE');
    const active = await client.query(`SELECT "providerId",count(*)::int AS count FROM services WHERE status='ACTIVE' GROUP BY "providerId" ORDER BY "providerId"`);
    assert.deepEqual(active.rows, [{ providerId:'expired',count:1 },{ providerId:'free',count:1 },{ providerId:'pro',count:4 }]);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM services')).rows[0].count,12);
    assert.equal((await client.query(`SELECT id FROM services WHERE "providerId"='free' AND status='ACTIVE'`)).rows[0].id,'free1');
  } finally {
    assert.match(schema,/^servicehub_migration_test_[a-f0-9]{32}$/);
    try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
  }
});
