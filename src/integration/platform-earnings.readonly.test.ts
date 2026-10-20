import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { env } from '../config/env';
import { enforceDatabaseTlsVerification } from '../config/database-url';
import { platformEarningsSql } from '../services/platform-earnings.service';
import { PlatformEarningsQuerySchema } from '../schema/platform-earnings.schema';

const pool = new Pool({ connectionString: enforceDatabaseTlsVerification(env.DATABASE_URL), connectionTimeoutMillis: 10_000 });
let client: PoolClient;
before(async () => { client = await pool.connect(); await client.query('BEGIN READ ONLY'); });
after(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } await pool.end(); });
const fixtures = ['earned', 'held', 'review', 'refunded', 'failed', 'pending', 'earned'].map((status, i) => ({
  id: 'synthetic-' + i, bookingId: 'booking-' + i, reference: 'pi-' + i, serviceTitle: 'Synthetic service', customerName: 'Synthetic customer', providerName: 'Synthetic provider',
  amount: 1000, platformFeeAmount: i === 6 ? 0 : 100, providerNetAmount: i === 6 ? 1000 : 900,
  commissionRateBps: i === 6 ? 0 : 1000, isTestMode: true, paidAt: null,
  recordedAt: '2026-10-19T16:01:00', status, earnedFee: i === 0 ? 100 : 0,
}));
async function report(filters: object = {}) {
  const query = platformEarningsSql(PlatformEarningsQuerySchema.parse({ period: 'custom', from: '2026-10-01', to: '2026-10-20', ...filters }), new Date('2026-10-20T01:00:00Z'));
  const boundary = query.text.indexOf('), dated AS (');
  assert.ok(boundary > 0);
  // Replace only the source records; execute the production aggregates, date
  // boundaries, status filter, pagination and chart over SELECT-only fixtures.
  const tail = query.text.slice(boundary).replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + 1));
  const text = `WITH records AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS fixture(
    id text, "bookingId" text, reference text, "serviceTitle" text, "customerName" text, "providerName" text,
    amount numeric, "platformFeeAmount" numeric, "providerNetAmount" numeric, "commissionRateBps" int,
    "isTestMode" boolean, "paidAt" timestamp, "recordedAt" timestamp, status text, "earnedFee" numeric
  ) ${tail}`;
  const { rows } = await client.query(text, [JSON.stringify(fixtures), ...query.values]);
  return rows[0];
}
test('earned totals exclude pending, disputed, failed and refunded fees; paid counts include captured reviews', async () => {
  const data = await report();
  assert.deepEqual(data.summary, { earnedTotal: 100, today: 100, week: 100, month: 100, pendingFees: 200 });
  assert.equal(data.period.transactions, 7);
  assert.equal(data.period.paidTransactions, 4);
  assert.equal(data.period.earnedFees, 100);
  assert.equal(data.trend.find((point: any) => point.date === '2026-10-20').amount, 100);
  assert.equal(data.trend.find((point: any) => point.date === '2026-10-19').amount, 0);
});
test('history status filters and page bounds do not alter period earnings', async () => {
  const data = await report({ status: 'refunded', limit: 1, page: 99 });
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].status, 'refunded');
  assert.equal(data.pagination.page, 1);
  assert.equal(data.pagination.total, 1);
  assert.equal(data.period.earnedFees, 100);
  const empty = await report({ from: '2026-10-01', to: '2026-10-19' });
  assert.equal(empty.pagination.total, 0);
  assert.equal(empty.period.earnedFees, 0);
  assert.equal(empty.summary.earnedTotal, 100);
});
