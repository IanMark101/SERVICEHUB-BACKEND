import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { env } from '../config/env';
import { enforceDatabaseTlsVerification } from '../config/database-url';
import { ProviderPaymentRecordsQuerySchema } from '../schema/provider-payment-records.schema';
import { providerPaymentRecordsSql, type ProviderPaymentRecordsResult } from '../services/provider-payment-records.service';

// This suite uses SELECT-only fixtures and an explicitly read-only transaction.
// It never inserts fixtures, updates accounts or invokes any payment operation.
const pool = new Pool({ connectionString: enforceDatabaseTlsVerification(env.DATABASE_URL), connectionTimeoutMillis: 10_000 });
let client: PoolClient;
before(async () => { client = await pool.connect(); await client.query('BEGIN READ ONLY'); });
after(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } await pool.end(); });

const fixtures = [
  ...Array.from({ length: 9 }, (_, i) => ({ id: 'cash-' + i, bookingId: 'cash-' + i, serviceTitle: 'Cash service', seekerName: 'Synthetic seeker', paymentMethod: 'On-site Cash', bookingStatus: 'COMPLETED', paymentStatus: 'CASH_CONFIRMED', amount: 0.1, earnedAmount: 0.1, recordedAt: '2026-10-09T16:00:00' })),
  { id: 'online', bookingId: 'online', serviceTitle: 'Online service', seekerName: 'Synthetic seeker', paymentMethod: 'GCash', bookingStatus: 'COMPLETED', paymentStatus: 'RELEASED', amount: 0.2, earnedAmount: 0.2, recordedAt: '2026-10-09T15:59:59' },
  { id: 'refund', bookingId: 'refund', serviceTitle: 'Refunded service', seekerName: 'Synthetic seeker', paymentMethod: 'GCash', bookingStatus: 'CANCELED', paymentStatus: 'REFUNDED', amount: 1500, earnedAmount: 0, recordedAt: '2026-10-09T17:00:00' },
  { id: 'cancel', bookingId: 'cancel', serviceTitle: 'Cancelled service', seekerName: 'Synthetic seeker', paymentMethod: 'On-site Cash', bookingStatus: 'CANCELED', paymentStatus: 'UNPAID', amount: 2500, earnedAmount: 0, recordedAt: '2026-10-01T01:00:00' },
  { id: 'unsettled', bookingId: 'unsettled', serviceTitle: 'Legacy unconfirmed service', seekerName: 'Synthetic seeker', paymentMethod: 'GCash', bookingStatus: 'COMPLETED', paymentStatus: 'PAID_HELD', amount: 500, earnedAmount: 0, recordedAt: '2026-10-09T17:00:00' },
  { id: 'legacy', bookingId: null, serviceTitle: 'Archived service', seekerName: 'Synthetic seeker', paymentMethod: 'GCash', bookingStatus: 'COMPLETED', paymentStatus: 'RELEASED', amount: 100, earnedAmount: 100, recordedAt: '2026-10-01T01:00:00' },
];

async function fixtureResult(params: object = {}): Promise<ProviderPaymentRecordsResult> {
  const query = providerPaymentRecordsSql('fixture-provider', ProviderPaymentRecordsQuerySchema.parse(params));
  const boundary = query.text.indexOf('), classified AS (');
  assert.ok(boundary > 0);
  const recordParameterCount = Math.max(...[...query.text.slice(0, boundary).matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
  // Substitute SELECT-only input rows; execute the production classification,
  // date filters, numeric aggregates, deep-link lookup and page slicing unchanged.
  const tail = query.text.slice(boundary).replace(/\$(\d+)/g, (_, index: string) => '$' + (Number(index) - recordParameterCount + 1));
  const text = `WITH records AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS fixture(
    id text, "bookingId" text, "serviceTitle" text, "seekerName" text, "paymentMethod" text,
    "bookingStatus" text, "paymentStatus" text, amount numeric, "earnedAmount" numeric, "recordedAt" timestamp
  ) ${tail}`;
  const result = await client.query(text, [JSON.stringify(fixtures), ...query.values.slice(recordParameterCount)]);
  return result.rows[0];
}

test('SQL totals are exact across every page and exclude refunded/cancelled/unconfirmed amounts', async () => {
  const first = await fixtureResult();
  assert.deepEqual(first.summary, { earnedTotal: 101.1, cashTotal: 0.9, onlineTotal: 100.2, completedCount: 11 });
  assert.deepEqual(first.pagination, { page: 1, limit: 8, total: 14, totalPages: 2 });
  assert.equal(first.items.length, 8);
  const second = await fixtureResult({ page: 2 });
  assert.deepEqual(second.summary, first.summary);
  assert.equal(second.items.length, 6);
  assert.equal(second.items.find(row => row.id === 'legacy')?.earnedAmount, 100);
  assert.equal(second.items.find(row => row.id === 'legacy')?.bookingId, null);
});

test('date filters use the Philippine midnight boundary while preserving the lifetime total', async () => {
  const today = await fixtureResult({ date: '2026-10-10', limit: 50 });
  assert.equal(today.pagination.total, 11);
  assert.equal(today.items.some(row => row.id === 'online'), false);
  const yesterday = await fixtureResult({ date: '2026-10-09' });
  assert.deepEqual(yesterday.items.map(row => row.id), ['online']);
  assert.equal(yesterday.summary.earnedTotal, 101.1);
});

test('refund filters show zero earnings, empty filters stay empty and pages clamp safely', async () => {
  const refunded = await fixtureResult({ status: 'refunded' });
  assert.equal(refunded.items.length, 1);
  assert.equal(refunded.items[0].earnedAmount, 0);
  assert.equal(refunded.items[0].amount, 1500);
  const empty = await fixtureResult({ date: '2000-01-01', page: 99 });
  assert.deepEqual(empty.pagination, { page: 1, limit: 8, total: 0, totalPages: 1 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.summary.earnedTotal, 101.1);
  assert.equal((await fixtureResult({ page: 99 })).pagination.page, 2);
});

test('a linked older booking opens its actual page; an absent link cannot reveal another record', async () => {
  const linked = await fixtureResult({ booking: 'legacy' });
  assert.equal(linked.linkedRecordFound, true);
  assert.equal(linked.pagination.page, 2);
  assert.ok(linked.items.some(row => row.id === 'legacy'));
  const absent = await fixtureResult({ booking: 'another-provider-booking' });
  assert.equal(absent.linkedRecordFound, false);
  assert.equal(absent.pagination.page, 1);
});

test('the actual provider projection matches independent settled-completion totals without wallet refunds', async () => {
  const providers = await client.query('SELECT DISTINCT "providerId" FROM bookings ORDER BY "providerId" LIMIT 3');
  assert.ok(providers.rows.length > 0, 'A read-only history sample is required');
  for (const { providerId } of providers.rows) {
    const query = providerPaymentRecordsSql(providerId, ProviderPaymentRecordsQuerySchema.parse({}));
    const { rows: [actual] } = await client.query(query.text, query.values);
    const { rows: [expected] } = await client.query(`SELECT COALESCE(SUM(cs."finalPrice"), 0)::text AS total
      FROM completed_services cs LEFT JOIN bookings b ON b.id = cs."bookingId"
      WHERE cs."providerId" = $1 AND cs."seekerId" <> $1 AND cs."paymentStatus" IN ('RELEASED', 'CASH_CONFIRMED')
        AND (cs."bookingId" IS NULL OR (b."providerId" = $1 AND b.status = 'COMPLETED' AND b."paymentStatus" = cs."paymentStatus"))`, [providerId]);
    assert.equal(actual.summary.earnedTotal, Number(expected.total));
    for (const row of actual.items) {
      assert.equal('privateAddress' in row || 'phone' in row || 'walletOwnerId' in row, false);
      if (row.bookingId) {
        const scoped = await client.query('SELECT "providerId" FROM bookings WHERE id = $1', [row.bookingId]);
        assert.equal(scoped.rows[0].providerId, providerId);
      }
    }
  }
});
