import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { startSubscriptionCheckout, quoteProviderMembership, enrollProviderMembership, reconcileSubscriptionPayment, cancelProviderSubscription, cancelSubscriptionCheckout, getProviderSubscription, adminSubscriptionOverview } from '../services/subscriptions.service';
import { startProviderTrial, maintainProviderMemberships } from '../services/provider-membership.service';
import { createService, toggleServiceAvailability, publicServiceWhere } from '../services/services.service';
import { CreateServiceSchema } from '../schema/services.schema';
import { initiateOnlinePayment } from '../services/payment-attempt.service';
import { getProviderPaymentRecords } from '../services/provider-payment-records.service';
import { getProviderAnalytics } from '../services/provider-analytics.service';
import { getAccountDeletionEligibility } from '../services/account-deletion.service';
import { createDirectRequest, respondToDirectBookingService } from '../services/bookings/direct-bookings.service';
import { providerStartJob } from '../services/bookings/provider-operations.service';
import { markJobComplete, confirmCompletionService } from '../services/bookings/completion.service';
import { sendMessage } from '../services/messages.service';
import { listRequests } from '../services/requests.service';
import { joinWaitlist } from '../services/bookings/waitlist.service';
import { getSavedListings, saveListing, unsaveListing } from '../services/saved-listings.service';

test('three memberships use real isolated records and a simulated gateway', async t => {
  assert.match(new URL(env.DATABASE_URL).searchParams.get('schema') || '', /^servicehub_migration_test_[a-f0-9]{32}$/);
  t.after(async () => { await prisma.$disconnect(); });
  const suffix = Date.now().toString();
  const user = (name: string) => prisma.user.create({ data: { name, email: `${name}-${suffix}@example.test`, passwordHash: 'fixture-only', phone: '09123456789', gcashNumber: '09123456789', location: 'Cordova', emailVerified: true, verificationStatus: 'APPROVED' } });
  const provider = await user('membershipprovider');
  const customer = await user('membershipcustomer');
  const other = await user('membershipother');
  const category = await prisma.category.create({ data: { name: `Membership Fixture ${suffix}` } });
  const input = (i: number) => CreateServiceSchema.parse({ categoryId: category.id, title: `Laptop repair service ${i}`, description: 'Laptop diagnosis and repair for home and school use.', price: 1000, priceType: 'FIXED', estimatedDurationMins: 60, serviceLocationMode: 'REMOTE', paymentMethods: { gcash: true, cash: true } });
  const initialFetch = globalThis.fetch;
  const initialSecret = env.PAYMONGO_SECRET_KEY; const initialPublic = env.PAYMONGO_PUBLIC_KEY; const initialWebhook = env.PAYMONGO_WEBHOOK_SECRET;
  env.PAYMONGO_SECRET_KEY = 'sk_test_membership_fixture'; env.PAYMONGO_PUBLIC_KEY = 'pk_test_membership_fixture'; env.PAYMONGO_WEBHOOK_SECRET = 'membership_webhook_fixture';
  const intents = new Map<string, any>(); const idempotency = new Map<string, string>(); let sequence = 0;
  globalThis.fetch = (async (url: any, options: any = {}) => {
    assert.ok(String(url).startsWith('https://api.paymongo.com/v1/'), 'No external services');
    if (String(url).endsWith('/payment_intents') && options.method === 'POST') {
      const key = options.headers['Idempotency-Key']; const id = idempotency.get(key) ?? `pi_member${++sequence}`;
      if (!intents.has(id)) intents.set(id, { ...JSON.parse(options.body).data.attributes, status: 'awaiting_payment_method', client_key: `secret_${id}` });
      idempotency.set(key, id); return Response.json({ data: { id, attributes: intents.get(id) } });
    }
    if (String(url).endsWith('/payment_methods')) return Response.json({ data: { id: 'pm_fixture' } });
    if (String(url).endsWith('/attach')) {
      const intent = intents.get(String(url).split('/').at(-2)!);
      intent.status = 'awaiting_next_action'; intent.next_action = { type: 'redirect', redirect: { url: 'https://test-sources.paymongo.com/membership-fixture' } };
      return Response.json({ data: { attributes: intent } });
    }
    const id = String(url).split('/').at(-1)!; assert.ok(intents.has(id));
    return Response.json({ data: { id, attributes: intents.get(id) } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = initialFetch; env.PAYMONGO_SECRET_KEY = initialSecret; env.PAYMONGO_PUBLIC_KEY = initialPublic; env.PAYMONGO_WEBHOOK_SECRET = initialWebhook; });
  const paid = (id: string) => { const intent = intents.get(id); intent.status = 'succeeded'; intent.payments = [{ id: `pay_${id}` }]; };
  const checkout = async (id: string, plan: 'BASIC' | 'PRO') => {
    const quote = await quoteProviderMembership(id, plan);
    return startSubscriptionCheckout(id, plan, quote.quoteToken);
  };
  const activate = async (id: string, plan: 'BASIC' | 'PRO') => { const payment = await checkout(id, plan); paid(payment.paymentIntentId!); return reconcileSubscriptionPayment(id, payment.paymentIntentId!); };
  let listingId: string; let freeAttemptId: string; let upgradeAmount = 0;

  await t.test('customer browsing does not enroll; trial enrollment is one-time and concurrent Free creation allows one', async () => {
    assert.equal((await getProviderSubscription(customer.id)).trialStarted, false);
    await assert.rejects(quoteProviderMembership(customer.id, 'BASIC'), /Provider workspace/);
    assert.equal(await prisma.subscriptionPayment.count({ where: { providerId: customer.id } }), 0);
    const results = await Promise.allSettled([1, 2, 3, 4].map(i => createService(provider.id, input(i))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const listing = await prisma.service.findFirstOrThrow({ where: { providerId: provider.id } }); listingId = listing.id;
    const first = await startProviderTrial(provider.id); const again = await startProviderTrial(provider.id);
    assert.equal(first.freePlanStartedAt?.getTime(), again.freePlanStartedAt?.getTime());
    assert.equal(first.freePlanExpiresAt!.getTime() - first.freePlanStartedAt!.getTime(), 30 * 86400000);
    assert.equal((await getProviderAnalytics(provider.id)).level, 'BASIC');
  });
  await t.test('Free GCash uses 10%; a Basic click is not payment, verified Basic costs 99 and uses 8%', async () => {
    const attempt = await initiateOnlinePayment({ seekerId: customer.id, serviceId: listingId, paymentMethod: 'gcash', serviceLocationMode: 'REMOTE' });
    freeAttemptId = attempt.id; assert.equal(attempt.commissionRateBps, 1000); assert.equal(Number(attempt.platformFeeAmount), 100);
    const pending = await checkout(provider.id, 'BASIC'); assert.equal(pending.amount, 99);
    assert.equal((await checkout(provider.id, 'BASIC')).id, pending.id);
    assert.equal((await getProviderSubscription(provider.id)).plan, 'FREE');
    await assert.rejects(reconcileSubscriptionPayment(other.id, pending.paymentIntentId!), /not found/);
    paid(pending.paymentIntentId!);
    const metadata = intents.get(pending.paymentIntentId!).metadata;
    intents.get(pending.paymentIntentId!).metadata = { ...metadata, servicehub_provider_id: other.id };
    await assert.rejects(reconcileSubscriptionPayment(provider.id, pending.paymentIntentId!), /do not match/);
    intents.get(pending.paymentIntentId!).metadata = metadata;
    const verified = await reconcileSubscriptionPayment(provider.id, pending.paymentIntentId!);
    assert.equal(verified.paymentStatus, 'SUCCEEDED'); assert.equal((await getProviderSubscription(provider.id)).plan, 'BASIC');
    const replay = await reconcileSubscriptionPayment(provider.id, pending.paymentIntentId!);
    assert.equal(replay.subscriptionExpiresAt?.getTime(), verified.subscriptionExpiresAt?.getTime());
    const more = await Promise.allSettled([5, 6, 7].map(i => createService(provider.id, input(i))));
    assert.equal(more.filter(r => r.status === 'fulfilled').length, 2, 'Basic has at most three');
    const service = await prisma.service.findFirstOrThrow({ where: { providerId: provider.id, id: { not: listingId } } });
    const basicAttempt = await initiateOnlinePayment({ seekerId: other.id, serviceId: service.id, paymentMethod: 'gcash', serviceLocationMode: 'REMOTE' });
    assert.equal(basicAttempt.commissionRateBps, 800); assert.equal(Number(basicAttempt.platformFeeAmount), 80); assert.equal(Number(basicAttempt.providerNetAmount), 920);
  });
  await t.test('Basic to Pro uses the reviewed prorated amount and keeps the original paid period', async () => {
    const before = await getProviderSubscription(provider.id);
    const quote = await quoteProviderMembership(provider.id, 'PRO'); upgradeAmount = quote.amount;
    assert.ok(quote.amount > 0 && quote.amount <= 100); assert.equal(quote.billingAction, 'UPGRADE');
    const pending = await startSubscriptionCheckout(provider.id, 'PRO', quote.quoteToken); assert.equal(pending.amount, quote.amount);
    paid(pending.paymentIntentId!); await Promise.all([reconcileSubscriptionPayment(provider.id, pending.paymentIntentId!), reconcileSubscriptionPayment(provider.id, pending.paymentIntentId!)]);
    const after = await getProviderSubscription(provider.id);
    assert.equal(after.plan, 'PRO'); assert.equal(after.expiresAt?.getTime(), before.expiresAt?.getTime()); assert.equal(after.startsAt?.getTime(), before.startsAt?.getTime());
    assert.equal(await prisma.notification.count({ where: { id: `membership-paid:${pending.id}` } }), 1);
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: freeAttemptId } })).commissionRateBps, 1000);
    const extra = await Promise.all([8, 9, 10, 11].map(i => createService(provider.id, input(i)))); assert.equal(extra.length, 4);
    const attempt = await initiateOnlinePayment({ seekerId: customer.id, serviceId: extra[0]!.id, paymentMethod: 'gcash', serviceLocationMode: 'REMOTE' });
    assert.equal(attempt.commissionRateBps, 500); assert.equal(Number(attempt.platformFeeAmount), 50); assert.equal(Number(attempt.providerNetAmount), 950);
  });
  await t.test('cancelled Pro keeps access until expiry; expiration preserves records but hides public listings', async () => {
    const cancelled = await cancelProviderSubscription(provider.id); assert.equal(cancelled.plan, 'PRO'); assert.equal(cancelled.marketplaceAccess, true);
    await assert.rejects(quoteProviderMembership(provider.id, 'BASIC'), /after that date/);
    await prisma.user.update({ where: { id: provider.id }, data: { subscriptionExpiresAt: new Date(Date.now() - 21 * 86400000) } });
    const expired = await getProviderSubscription(provider.id);
    assert.equal(expired.plan, 'PRO'); assert.equal(expired.subscriptionStatus, 'EXPIRED'); assert.equal(expired.activeListings, 7);
    assert.equal(await prisma.service.count({ where: { ...publicServiceWhere(), providerId: provider.id } }), 0);
    await assert.rejects(createService(provider.id, input(12)), /membership has ended/);
    await assert.rejects(initiateOnlinePayment({ seekerId: other.id, serviceId: listingId, paymentMethod: 'gcash', serviceLocationMode: 'REMOTE' }), /membership has ended/);
    await assert.rejects(listRequests(undefined, provider.id), /membership has ended/);
    const publicRequest = await prisma.serviceRequest.create({ data: {
      seekerId: customer.id, categoryId: category.id, title: 'Remote laptop repair request',
      description: 'Inspect the laptop and agree the repair work.', budgetMin: 50, budgetMax: 100,
      urgency: 'FLEXIBLE', serviceLocationMode: 'REMOTE', paymentMethods: { cash: true, gcash: true },
    } });
    await assert.rejects(listRequests(undefined, provider.id, undefined, [publicRequest.id]), /membership has ended/);
    assert.equal((await listRequests(undefined, customer.id, undefined, [publicRequest.id])).length, 1);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).freePlanStartedAt, null,
      'Reading an owned Customer request must not enroll a Provider trial');
    const ownedRequest = await prisma.serviceRequest.create({ data: {
      seekerId: provider.id, categoryId: category.id, title: 'My own customer request',
      description: 'A member can still act as a Customer after Provider expiry.', budgetMin: 50, budgetMax: 100,
      urgency: 'FLEXIBLE', serviceLocationMode: 'REMOTE', paymentMethods: { cash: true, gcash: true },
    } });
    assert.equal((await listRequests(undefined, provider.id, undefined, [ownedRequest.id])).length, 1);
    await assert.rejects(joinWaitlist(listingId, other.id), /membership has ended/);
    await toggleServiceAvailability(listingId, provider.id);
    await assert.rejects(toggleServiceAvailability(listingId, provider.id), /membership has ended/);
    assert.ok((await getProviderPaymentRecords(prisma, provider.id, { page: 1, limit: 10, status: 'all' })).summary);
    assert.equal((await getProviderAnalytics(provider.id)).level, 'BASIC');
  });
  await t.test('Saved applies expiry to request details and new saves, preserving removal and free Customer browsing', async () => {
    const person = await user('savedprovider');
    const reader = await user('savedcustomer');
    const unenrolled = await user('savedunenrolled');
    const service = await createService(person.id, input(30));
    const request = await prisma.serviceRequest.create({ data: {
      seekerId: reader.id, categoryId: category.id, title: 'Saved laptop repair request',
      description: 'Repair the school laptop.', budgetMin: 100, budgetMax: 500,
      urgency: 'FLEXIBLE', serviceLocationMode: 'REMOTE', paymentMethods: { cash: true, gcash: true },
    } });
    await saveListing(person.id, 'SERVICE_REQUEST', request.id);
    assert.equal((await getSavedListings(person.id, 'SERVICE_REQUEST', 1, 12)).items[0]!.listing?.id, request.id);
    await saveListing(reader.id, 'SERVICE_LISTING', service.id);
    assert.equal((await getSavedListings(reader.id, 'SERVICE_LISTING', 1, 12)).items[0]!.listing?.id, service.id);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: reader.id } })).freePlanStartedAt, null);
    await prisma.savedListing.create({ data: { userId: unenrolled.id, requestId: request.id } });
    assert.equal((await getSavedListings(unenrolled.id, 'SERVICE_REQUEST', 1, 12)).items[0]!.listing, null);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: unenrolled.id } })).freePlanStartedAt, null);
    await prisma.user.update({ where: { id: person.id }, data: { freePlanExpiresAt: new Date(Date.now() - 1) } });
    const hidden = await getSavedListings(person.id, 'SERVICE_REQUEST', 1, 12);
    assert.equal(hidden.items.length, 1); assert.equal(hidden.items[0]!.listing, null);
    await assert.rejects(saveListing(person.id, 'SERVICE_REQUEST', request.id), error => (error as { code?: string }).code === 'PROVIDER_MEMBERSHIP_EXPIRED');
    await unsaveListing(person.id, 'SERVICE_REQUEST', request.id);
    await unsaveListing(person.id, 'SERVICE_REQUEST', request.id);
    assert.equal((await getSavedListings(person.id, 'SERVICE_REQUEST', 1, 12)).items.length, 0);
    await unsaveListing(unenrolled.id, 'SERVICE_REQUEST', request.id);
  });
  await t.test('Pro to Basic after weeks expired discloses and pauses excess listings without deletion', async () => {
    const retained = await prisma.service.findMany({ where: { providerId: provider.id, status: 'ACTIVE' }, orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    const quote = await quoteProviderMembership(provider.id, 'BASIC'); assert.equal(quote.listingsToPause, 3); assert.equal(quote.amount, 99);
    const payment = await startSubscriptionCheckout(provider.id, 'BASIC', quote.quoteToken); paid(payment.paymentIntentId!);
    await reconcileSubscriptionPayment(provider.id, payment.paymentIntentId!);
    const now = await getProviderSubscription(provider.id); assert.equal(now.plan, 'BASIC'); assert.equal(now.activeListings, 3); assert.equal(now.marketplaceAccess, true);
    const active = await prisma.service.findMany({ where: { providerId: provider.id, status: 'ACTIVE' }, orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    assert.deepEqual(active, retained.slice(0, 3)); assert.equal(await prisma.service.count({ where: { providerId: provider.id } }), 7);
    assert.equal(await prisma.service.count({ where: { ...publicServiceWhere(), providerId: provider.id } }), 3);
  });
  await t.test('failed, cancelled, expired and late charged checkouts never grant unpaid membership', async () => {
    await enrollProviderMembership(other.id);
    const failed = await checkout(other.id, 'PRO'); intents.get(failed.paymentIntentId!).status = 'awaiting_payment_method';
    assert.equal((await reconcileSubscriptionPayment(other.id, failed.paymentIntentId!)).paymentStatus, 'FAILED');
    assert.equal((await getProviderSubscription(other.id)).plan, 'FREE');
    const abandoned = await checkout(other.id, 'PRO'); assert.equal((await cancelSubscriptionCheckout(other.id, abandoned.paymentIntentId!)).paymentStatus, 'CANCELLED');
    paid(abandoned.paymentIntentId!); assert.equal((await reconcileSubscriptionPayment(other.id, abandoned.paymentIntentId!)).paymentStatus, 'REFUNDED');
    const timeout = await checkout(other.id, 'PRO'); await prisma.subscriptionPayment.update({ where: { id: timeout.id }, data: { checkoutExpiresAt: new Date(Date.now() - 1) } });
    assert.equal((await reconcileSubscriptionPayment(other.id, timeout.paymentIntentId!)).paymentStatus, 'EXPIRED');
    assert.equal((await getProviderSubscription(other.id)).plan, 'FREE');
  });
  await t.test('a paid upgrade that cannot activate is refunded; tampered and another-owner quotes are rejected', async () => {
    const quote = await quoteProviderMembership(provider.id, 'PRO');
    await assert.rejects(startSubscriptionCheckout(provider.id, 'PRO', quote.quoteToken + 'x'), /Refresh the price/);
    await assert.rejects(startSubscriptionCheckout(other.id, 'PRO', quote.quoteToken), /price expired/);
    const payment = await startSubscriptionCheckout(provider.id, 'PRO', quote.quoteToken);
    await cancelProviderSubscription(provider.id); paid(payment.paymentIntentId!);
    assert.equal((await reconcileSubscriptionPayment(provider.id, payment.paymentIntentId!)).paymentStatus, 'REFUNDED');
    assert.equal((await getProviderSubscription(provider.id)).plan, 'BASIC');
  });
  await t.test('network interruption recovers one checkout and preserves deletion safeguards', async () => {
    const person = await user('membershipnetwork'); await enrollProviderMembership(person.id);
    const gatewayFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('Simulated network interruption'); }) as typeof fetch;
    await assert.rejects(checkout(person.id, 'PRO'), /unavailable/); globalThis.fetch = gatewayFetch;
    const recovered = await checkout(person.id, 'PRO');
    assert.equal(await prisma.subscriptionPayment.count({ where: { providerId: person.id } }), 1);
    assert.equal((await getAccountDeletionEligibility(person.id)).counts.paymentAttempts, 1);
    await cancelSubscriptionCheckout(person.id, recovered.paymentIntentId!);
    assert.equal((await getAccountDeletionEligibility(person.id)).eligible, true);
  });
  for (const plan of ['FREE', 'BASIC', 'PRO'] as const) await t.test(`${plan} expiry preserves scheduled accepted work, messages, start and cash completion`, async () => {
    const person = await user(`existing${plan}`); const listing = await createService(person.id, input(20));
    if (plan !== 'FREE') await activate(person.id, plan);
    const request = await createDirectRequest({ seekerId: customer.id, providerId: person.id, serviceId: listing.id, serviceLocationMode: 'REMOTE', schedule: new Date(Date.now() + 2 * 86400000).toISOString() });
    await respondToDirectBookingService(request.booking.id, person.id, true);
    await prisma.user.update({ where: { id: person.id }, data: plan === 'FREE' ? { freePlanExpiresAt: new Date(Date.now() - 1) } : { subscriptionExpiresAt: new Date(Date.now() - 1) } });
    await assert.rejects(createDirectRequest({ seekerId: other.id, providerId: person.id, serviceId: listing.id, serviceLocationMode: 'REMOTE' }), /membership has ended/);
    const message = await sendMessage(request.booking.id, person.id, 'I can still complete our confirmed booking.'); assert.equal(message.content, 'I can still complete our confirmed booking.');
    await providerStartJob(request.booking.id, person.id); await markJobComplete(request.booking.id, person.id); await confirmCompletionService(request.booking.id, customer.id);
    const completed = await prisma.completedService.findUniqueOrThrow({ where: { bookingId: request.booking.id } });
    assert.equal(completed.paymentStatus, 'CASH_CONFIRMED'); assert.equal(Number(completed.platformFeeAmount), 0); assert.equal(Number(completed.providerNetAmount), 1000);
    assert.equal((await getProviderSubscription(person.id)).plan, plan);
  });
  await t.test('paid analytics use settled owner records, exact money and the Philippine date window', async () => {
    await prisma.completedService.createMany({ data: [
      { providerId: provider.id, seekerId: customer.id, finalPrice: 1000, providerNetAmount: 920, platformFeeAmount: 80, paymentStatus: 'RELEASED' },
      { providerId: provider.id, seekerId: customer.id, finalPrice: '0.10', providerNetAmount: '0.10', paymentStatus: 'CASH_CONFIRMED' },
      { providerId: provider.id, seekerId: customer.id, finalPrice: '0.20', providerNetAmount: '0.20', paymentStatus: 'CASH_CONFIRMED' },
      { providerId: provider.id, seekerId: customer.id, finalPrice: 5000, providerNetAmount: 5000, paymentStatus: 'REFUNDED' },
      { providerId: provider.id, seekerId: customer.id, finalPrice: 6000, providerNetAmount: 6000, paymentStatus: 'PAID_HELD' },
      { providerId: provider.id, seekerId: customer.id, finalPrice: 7000, providerNetAmount: 7000, paymentStatus: 'RELEASED', completedAt: new Date(Date.now() - 40 * 86400000) },
    ] });
    const analytics = await getProviderAnalytics(provider.id); assert.equal(analytics.level, 'FULL');
    assert.deepEqual(analytics.summary, { earned: 920.3, cash: 0.3, gcash: 920, fees: 80, completed: 3, averagePerBooking: 306.77 });
    assert.equal(analytics.daily?.reduce((total, row) => total + row.completed, 0), 3);
  });
  await t.test('reminder maintenance skips an account removed after its scan and continues other notices', async () => {
    const removed = await user('removedreminder');
    const retained = await user('retainedreminder');
    await startProviderTrial(removed.id); await startProviderTrial(retained.id);
    const now = new Date();
    await prisma.user.updateMany({ where: { id: { in: [removed.id, retained.id] } }, data: {
      freePlanExpiresAt: new Date(now.getTime() + 86_400_000),
    } });
    const originalFindMany = prisma.user.findMany.bind(prisma.user);
    let removedAfterScan = false;
    prisma.user.findMany = (async (...args: Parameters<typeof prisma.user.findMany>) => {
      const rows = await originalFindMany(...args);
      if (!removedAfterScan && rows.some(row => row.id === removed.id)) {
        await prisma.user.delete({ where: { id: removed.id } });
        removedAfterScan = true;
      }
      return rows;
    }) as typeof prisma.user.findMany;
    try {
      await maintainProviderMemberships(now);
      assert.equal(removedAfterScan, true);
      assert.equal(await prisma.notification.count({ where: { userId: retained.id, title: 'Your Free Provider plan ends tomorrow' } }), 1);
    } finally { prisma.user.findMany = originalFindMany; }
  });
  await t.test('reminders and expiry notices are once per period; expired Free cannot restart', async () => {
    const person = await user('membershipreminder'); const first = await startProviderTrial(person.id); const end = first.freePlanExpiresAt!;
    const week = new Date(end.getTime() - 7 * 86400000); const tomorrow = new Date(end.getTime() - 86400000);
    await maintainProviderMemberships(week); await maintainProviderMemberships(week); await maintainProviderMemberships(tomorrow); await maintainProviderMemberships(tomorrow); await maintainProviderMemberships(end); await maintainProviderMemberships(end);
    assert.equal(await prisma.notification.count({ where: { userId: person.id, id: { startsWith: 'membership:' } } }), 3);
    assert.equal((await startProviderTrial(person.id)).freePlanExpiresAt?.getTime(), end.getTime());
  });
  await t.test('admin shows all plans and excludes simulated payments from actual membership revenue', async () => {
    const overview = await adminSubscriptionOverview(1, 100);
    assert.equal(overview.summary.subscriptionRevenue, 0);
    const expected = await prisma.subscriptionPayment.aggregate({ where: { paymentStatus: 'SUCCEEDED', isTestMode: true }, _sum: { amount: true } });
    assert.equal(overview.summary.testSubscriptionTotal, Number(expected._sum.amount)); assert.ok(upgradeAmount > 0);
    assert.ok(overview.memberships.some(row => row.plan === 'BASIC')); assert.ok(overview.memberships.some(row => row.plan === 'PRO'));
  });
});
