import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { providerPaymentRecordsSql } from '../services/provider-payment-records.service';
import { ProviderPaymentRecordsQuerySchema } from '../schema/provider-payment-records.schema';

test('payment history combines net GCash, full cash and unchanged legacy earnings', async () => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_/);
  const suffix = Date.now();
  const users = await Promise.all(['customer', 'provider'].map(name => prisma.user.create({ data: { name, email: `${name}-${suffix}@example.test`, passwordHash: 'fixture-only', phone: '09123456789', location: 'Cordova' } })));
  const [customer, provider] = users;
  for (const [method, fee, net] of [['GCash', 50, 450], ['On-site Cash', 0, 500], ['GCash', 0, null]] as const) {
    const paymentStatus = method === 'GCash' ? 'RELEASED' : 'CASH_CONFIRMED';
    const booking = await prisma.booking.create({ data: { seekerId: customer.id, providerId: provider.id, paymentMethod: method, paymentStatus, status: 'COMPLETED', agreedAmount: 500 } });
    await prisma.completedService.create({ data: { bookingId: booking.id, seekerId: customer.id, providerId: provider.id, finalPrice: 500, paymentStatus, platformFeeAmount: fee, providerNetAmount: net, commissionRateBps: fee ? 1000 : 0 } });
  }
  const [result] = await prisma.$queryRaw<any[]>(providerPaymentRecordsSql(provider.id, ProviderPaymentRecordsQuerySchema.parse({})));
  assert.deepEqual(result.summary, { earnedTotal: 1450, cashTotal: 500, onlineTotal: 950, completedCount: 3 });
  assert.equal(result.items.find((item: any) => item.platformFeeAmount === 50).earnedAmount, 450);
  assert.equal(await prisma.transaction.count(), 0, 'Payment history does not depend on wallet ledger entries');
  await prisma.$disconnect();
});
