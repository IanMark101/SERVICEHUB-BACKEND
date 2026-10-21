import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { lockAccountLifecycle, assertActiveMarketplaceAccount } from './account-lifecycle.service';
import { attachPaymentMethod, createPaymentIntent, createPaymentMethod, createRefund, getPaymentIntent } from './paymongo.service';
import { oneCalendarMonthFrom, PRO_MONTHLY_PRICE, subscriptionBenefits, subscriptionSelect } from './subscription-policy';
import type { SubscriptionPayment } from '@prisma/client';

const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
const validRedirect = (url?: string | null) => {
  try { const parsed = new URL(url || ''); return parsed.protocol === 'https:' && (parsed.hostname === 'paymongo.com' || parsed.hostname.endsWith('.paymongo.com')); } catch { return false; }
};

export function subscriptionPaymentView(payment: SubscriptionPayment) {
  return { id: payment.id, plan: payment.plan, amount: Number(payment.amount), currency: payment.currency,
    paymentMethod: payment.paymentMethod, paymentReference: payment.paymentReference,
    paymentIntentId: payment.providerIntentId, paymentStatus: payment.paymentStatus,
    redirectUrl: validRedirect(payment.redirectUrl) ? payment.redirectUrl : null,
    isTestMode: payment.isTestMode, checkoutExpiresAt: payment.checkoutExpiresAt,
    subscriptionStartedAt: payment.subscriptionStartedAt, subscriptionExpiresAt: payment.subscriptionExpiresAt,
    createdAt: payment.createdAt, paidAt: payment.paidAt };
}

export async function getProviderSubscription(providerId: string) {
  const now = new Date();
  // Expiry is also checked by every benefit calculation; this write is only state maintenance.
  await prisma.user.updateMany({ where: { id: providerId, subscriptionPlan: 'PRO', subscriptionStatus: { in: ['ACTIVE', 'CANCELLED'] }, subscriptionExpiresAt: { lte: now } },
    data: { subscriptionStatus: 'EXPIRED', subscriptionUpdatedAt: now } });
  const [user, activeListings, payments] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: providerId }, select: { ...subscriptionSelect, subscriptionUpdatedAt: true } }),
    prisma.service.count({ where: { providerId, status: 'ACTIVE' } }),
    prisma.subscriptionPayment.findMany({ where: { providerId }, orderBy: { createdAt: 'desc' }, take: 30 }),
  ]);
  return { ...user, ...subscriptionBenefits(user, now), activeListings, monthlyPrice: PRO_MONTHLY_PRICE,
    isTestMode: !env.PAYMONGO_SECRET_KEY?.startsWith('sk_live_'),
    payments: payments.map(subscriptionPaymentView) };
}

export async function cancelProviderSubscription(providerId: string) {
  await prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, providerId);
    await assertActiveMarketplaceAccount(tx, providerId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: providerId }, select: subscriptionSelect });
    if (subscriptionBenefits(user).plan !== 'PRO') throw fail('There is no active Pro subscription to cancel.');
    await tx.user.update({ where: { id: providerId }, data: { subscriptionStatus: 'CANCELLED', subscriptionUpdatedAt: new Date() } });
  });
  return getProviderSubscription(providerId);
}

export async function startSubscriptionCheckout(providerId: string) {
  if (!env.PAYMONGO_SECRET_KEY || !env.PAYMONGO_PUBLIC_KEY || !env.PAYMONGO_WEBHOOK_SECRET) throw fail('GCash checkout is unavailable. Please try again later.', 503);
  const now = new Date();
  const payment = await prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, providerId);
    await assertActiveMarketplaceAccount(tx, providerId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: providerId }, select: subscriptionSelect });
    if (subscriptionBenefits(user, now).plan === 'PRO') throw fail('Your Pro plan is already active. You can renew after it expires.');
    // Never discard an unresolved charge to create another checkout.
    const existing = await tx.subscriptionPayment.findFirst({ where: { providerId, paymentStatus: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    if (existing?.redirectUrl && existing.checkoutExpiresAt > now) return existing;
    if (existing?.checkoutClaimedAt && existing.checkoutClaimedAt.getTime() > now.getTime() - 60_000) throw fail('Your checkout is being prepared. Please try again in a moment.');
    if (existing && existing.checkoutExpiresAt <= now && !existing.providerIntentId) {
      // An uncertain create-intent response must be recovered with the same key.
      return tx.subscriptionPayment.update({ where: { id: existing.id }, data: { checkoutClaimedAt: now } });
    }
    if (existing) return tx.subscriptionPayment.update({ where: { id: existing.id }, data: { checkoutClaimedAt: now } });
    return tx.subscriptionPayment.create({ data: { providerId, amount: PRO_MONTHLY_PRICE,
      idempotencyKey: `servicehub-subscription-${crypto.randomUUID()}`,
      checkoutExpiresAt: new Date(now.getTime() + 15 * 60_000), checkoutClaimedAt: now,
      isTestMode: !env.PAYMONGO_SECRET_KEY?.startsWith('sk_live_') } });
  });
  if (payment.redirectUrl && payment.checkoutExpiresAt > now) return subscriptionPaymentView(payment);
  try {
    const intent = payment.providerIntentId
      ? await getPaymentIntent(payment.providerIntentId)
      : await createPaymentIntent({ amount: PRO_MONTHLY_PRICE, description: 'ServiceHub Pro — one month', paymentMethod: 'gcash', idempotencyKey: payment.idempotencyKey,
        metadata: { servicehub_subscription_payment_id: payment.id, servicehub_provider_id: providerId, servicehub_purpose: 'provider_subscription' } });
    await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { providerIntentId: intent.id } });
    if (intent.status === 'succeeded') {
      await reconcileSubscriptionPayment(providerId, intent.id);
      return subscriptionPaymentView(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } }));
    }
    if (payment.checkoutExpiresAt <= new Date()) {
      await prisma.subscriptionPayment.updateMany({ where: { id: payment.id, paymentStatus: 'PENDING' }, data: { paymentStatus: 'EXPIRED', checkoutClaimedAt: null } });
      throw fail('This checkout expired. Start a new checkout.');
    }
    const restored = 'nextAction' in intent ? intent.nextAction?.redirect?.url : undefined;
    const clientKey = 'clientKey' in intent ? intent.clientKey : undefined;
    let redirectUrl = restored;
    if (!redirectUrl) {
      if (!clientKey) throw fail('GCash checkout could not be prepared. Please try again.', 502);
      const returnUrl = new URL('/subscription', env.FRONTEND_URL);
      returnUrl.searchParams.set('payment_intent_id', intent.id);
      const attached = await attachPaymentMethod({ paymentIntentId: intent.id, paymentMethodId: await createPaymentMethod('gcash'), clientKey, returnUrl: returnUrl.toString() });
      redirectUrl = attached.nextAction?.redirect?.url;
    }
    if (!validRedirect(redirectUrl)) throw fail('GCash did not return a valid checkout link. Please try again.', 502);
    const updated = await prisma.subscriptionPayment.updateMany({ where: { id: payment.id, paymentStatus: 'PENDING' }, data: { redirectUrl, checkoutClaimedAt: null, failureReason: null } });
    if (!updated.count) throw fail('This checkout is no longer pending. Refresh your subscription.');
    return subscriptionPaymentView(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } }));
  } catch (error) {
    await prisma.subscriptionPayment.updateMany({ where: { id: payment.id, paymentStatus: 'PENDING' }, data: { checkoutClaimedAt: null, failureReason: 'CHECKOUT_UNAVAILABLE' } });
    throw error;
  }
}

/** Called only with a server-retrieved PayMongo intent, never a browser payment flag. */
async function finalizeSubscriptionPayment(intent: Awaited<ReturnType<typeof getPaymentIntent>>) {
  const payment = await prisma.subscriptionPayment.findUnique({ where: { providerIntentId: intent.id } });
  if (!payment) throw fail('Subscription payment not found.', 404);
  if (intent.status !== 'succeeded') return payment;
  if (!intent.paymentId || intent.amount !== Number(payment.amount) || intent.currency !== 'PHP'
    || intent.metadata.servicehub_subscription_payment_id !== payment.id
    || intent.metadata.servicehub_provider_id !== payment.providerId
    || intent.metadata.servicehub_purpose !== 'provider_subscription') throw fail('Subscription payment details do not match.', 409);
  return prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, payment.providerId);
    const current = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } });
    if (['SUCCEEDED', 'REFUNDED', 'REFUND_REQUIRED'].includes(current.paymentStatus)) return current;
    const user = await tx.user.findUniqueOrThrow({ where: { id: payment.providerId } });
    const now = new Date();
    if (current.paymentStatus === 'CANCELLED' || user.role !== 'user' || !user.isActive || user.deactivatedAt || user.moderationStatus !== 'ACTIVE'
      || subscriptionBenefits(user, now).plan === 'PRO') {
      return tx.subscriptionPayment.update({ where: { id: payment.id }, data: { paymentStatus: 'REFUND_REQUIRED', paymentReference: intent.paymentId, paidAt: now, failureReason: 'PAID_SUBSCRIPTION_NOT_APPLIED' } });
    }
    const expiresAt = oneCalendarMonthFrom(now);
    await tx.user.update({ where: { id: payment.providerId }, data: { subscriptionPlan: 'PRO', subscriptionStatus: 'ACTIVE', subscriptionStartedAt: now, subscriptionExpiresAt: expiresAt, subscriptionUpdatedAt: now } });
    return tx.subscriptionPayment.update({ where: { id: payment.id }, data: { paymentStatus: 'SUCCEEDED', paymentReference: intent.paymentId,
      paidAt: now, subscriptionStartedAt: now, subscriptionExpiresAt: expiresAt, failureReason: null, checkoutClaimedAt: null } });
  });
}

export async function reconcileSubscriptionPayment(providerId: string, intentId: string) {
  const owned = await prisma.subscriptionPayment.findFirst({ where: { providerId, providerIntentId: intentId } });
  if (!owned) throw fail('Subscription payment not found.', 404);
  // Even expired/cancelled attempts are checked for a delayed successful charge.
  let payment = owned;
  if (!['SUCCEEDED', 'REFUNDED'].includes(owned.paymentStatus)) {
    const intent = await getPaymentIntent(intentId);
    if (intent.status === 'succeeded') payment = await finalizeSubscriptionPayment(intent);
    else if (owned.paymentStatus === 'PENDING' && (['awaiting_payment_method', 'cancelled'].includes(intent.status) || owned.checkoutExpiresAt <= new Date())) {
      const status = intent.status === 'awaiting_payment_method' ? 'FAILED' : intent.status === 'cancelled' ? 'CANCELLED' : 'EXPIRED';
      await prisma.subscriptionPayment.updateMany({ where: { id: owned.id, paymentStatus: 'PENDING' }, data: { paymentStatus: status } });
      payment = await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: owned.id } });
    }
  }
  if (payment.paymentStatus === 'REFUND_REQUIRED' && payment.paymentReference) {
    const refund = await createRefund({ paymentId: payment.paymentReference, reason: 'requested_by_customer', idempotencyKey: `subscription-refund-${payment.id}` });
    if (refund.status === 'succeeded' || (payment.isTestMode && refund.status === 'simulated_test_mode')) payment = await prisma.subscriptionPayment.update({ where: { id: payment.id }, data: { paymentStatus: 'REFUNDED', refundedAt: new Date() } });
  }
  return subscriptionPaymentView(payment);
}

export async function cancelSubscriptionCheckout(providerId: string, intentId: string) {
  const checked = await reconcileSubscriptionPayment(providerId, intentId);
  if (checked.paymentStatus !== 'PENDING') return checked;
  await prisma.$transaction(async tx => {
    await lockAccountLifecycle(tx, providerId);
    await tx.subscriptionPayment.updateMany({ where: { providerId, providerIntentId: intentId, paymentStatus: 'PENDING' }, data: { paymentStatus: 'CANCELLED' } });
  });
  return subscriptionPaymentView(await prisma.subscriptionPayment.findUniqueOrThrow({ where: { providerIntentId: intentId } }));
}

export async function handleSubscriptionWebhook(intentId: string) {
  const payment = await prisma.subscriptionPayment.findUnique({ where: { providerIntentId: intentId } });
  if (!payment) return false;
  await reconcileSubscriptionPayment(payment.providerId, intentId);
  return true;
}

export async function adminSubscriptionOverview(page: number, limit: number) {
  const now = new Date();
  const [activeProProviders, expiredProSubscriptions, revenue, testRevenue, total, payments] = await Promise.all([
    prisma.user.count({ where: { role: 'user', isActive: true, moderationStatus: 'ACTIVE', subscriptionPlan: 'PRO', subscriptionStatus: { in: ['ACTIVE', 'CANCELLED'] }, subscriptionStartedAt: { lte: now }, subscriptionExpiresAt: { gt: now } } }),
    prisma.user.count({ where: { role: 'user', subscriptionPlan: 'PRO', subscriptionExpiresAt: { lte: now } } }),
    prisma.subscriptionPayment.aggregate({ where: { paymentStatus: 'SUCCEEDED', isTestMode: false }, _sum: { amount: true } }),
    prisma.subscriptionPayment.aggregate({ where: { paymentStatus: 'SUCCEEDED', isTestMode: true }, _sum: { amount: true } }),
    prisma.subscriptionPayment.count(),
    prisma.subscriptionPayment.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
      include: { provider: { select: { id: true, name: true } } } }),
  ]);
  return { summary: { activeProProviders, expiredProSubscriptions, subscriptionRevenue: Number(revenue._sum.amount ?? 0), testSubscriptionTotal: Number(testRevenue._sum.amount ?? 0), isTestMode: !env.PAYMONGO_SECRET_KEY?.startsWith('sk_live_') },
    payments: payments.map(payment => ({ ...subscriptionPaymentView(payment), provider: payment.provider })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}
