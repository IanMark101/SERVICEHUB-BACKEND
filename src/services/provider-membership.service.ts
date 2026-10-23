import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from './account-lifecycle.service';
import { assertMembershipAccess, FREE_PERIOD_MS, subscriptionBenefits, subscriptionSelect } from './subscription-policy';
import { publishNotifications } from './notifications.service';

/** Account lifecycle lock serializes enrollment, listing changes and plan payments. */
export async function ensureProviderTrial(tx: Prisma.TransactionClient, providerId: string, now = new Date()) {
  await lockAccountLifecycle(tx, providerId);
  await assertActiveMarketplaceAccount(tx, providerId);
  const user = await tx.user.findUniqueOrThrow({ where: { id: providerId }, select: { ...subscriptionSelect, subscriptionUpdatedAt: true } });
  if (user.freePlanStartedAt) return user;
  return tx.user.update({ where: { id: providerId }, data: {
    freePlanStartedAt: now, freePlanExpiresAt: new Date(now.getTime() + FREE_PERIOD_MS),
    subscriptionUpdatedAt: now,
  }, select: { ...subscriptionSelect, subscriptionUpdatedAt: true } });
}

/** Only for a NEW marketplace commitment. Never call from existing-booking work. */
export async function assertNewProviderBusiness(tx: Prisma.TransactionClient, providerId: string, now = new Date()) {
  const user = await ensureProviderTrial(tx, providerId, now);
  assertMembershipAccess(user, now);
  return user;
}

export async function startProviderTrial(providerId: string) {
  return prisma.$transaction(tx => ensureProviderTrial(tx, providerId));
}

export async function requireProviderOpportunities(providerId: string) {
  return prisma.$transaction(tx => assertNewProviderBusiness(tx, providerId));
}

/** Expiration is enforced synchronously by policy and query filters. This job
 * maintains status and sends one stored reminder per period/milestone. */
export async function maintainProviderMemberships(now = new Date()) {
  const horizon = new Date(now.getTime() + 8 * 86_400_000);
  let cursor: string | undefined;
  let count = 0;
  while (true) {
    const users = await prisma.user.findMany({ where: {
      role: 'user', isActive: true, moderationStatus: 'ACTIVE', subscriptionStatus: { in: ['ACTIVE', 'CANCELLED'] },
      ...(cursor ? { id: { gt: cursor } } : {}),
      OR: [
        { subscriptionPlan: 'FREE', freePlanExpiresAt: { lte: horizon }, freePlanStartedAt: { not: null } },
        { subscriptionPlan: { in: ['BASIC', 'PRO'] }, subscriptionExpiresAt: { lte: horizon } },
      ],
    }, select: { id: true, ...subscriptionSelect }, orderBy: { id: 'asc' }, take: 100 });
    if (!users.length) break;
    for (const user of users) {
      const benefits = subscriptionBenefits(user, now);
      if (!benefits.expiresAt) continue;
      const days = Math.ceil((benefits.expiresAt.getTime() - now.getTime()) / 86_400_000);
      const milestone = days <= 0 ? 'expired' : days === 1 ? 'tomorrow' : days === 7 ? 'week' : null;
      if (!milestone) continue;
      const free = benefits.plan === 'FREE';
      const label = free ? 'Free Provider plan' : 'Provider membership';
      const title = milestone === 'expired' ? `Your ${label} has ended` : `Your ${label} ends ${milestone === 'tomorrow' ? 'tomorrow' : 'in 7 days'}`;
      const body = milestone === 'expired'
        ? 'Existing bookings remain available. Choose Basic or Pro to accept new customers.'
        : 'Choose Basic or Pro to continue receiving new customers. There are no automatic charges.';
      const inserted = await prisma.$transaction(async tx => {
        await lockAccountLifecycle(tx, user.id);
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: subscriptionSelect });
        const current = subscriptionBenefits(fresh, now);
        if (current.plan !== benefits.plan || current.expiresAt?.getTime() !== benefits.expiresAt!.getTime()) return 0;
        if (days <= 0) await tx.user.update({ where: { id: user.id }, data: { subscriptionStatus: 'EXPIRED' } });
        const result = await tx.notification.createMany({ data: [{
          id: `membership:${user.id}:${benefits.plan}:${benefits.expiresAt!.getTime()}:${milestone}`,
          userId: user.id, title, body, link: '/subscription',
        }], skipDuplicates: true });
        return result.count;
      });
      count += inserted;
      if (inserted) publishNotifications([user.id], title);
    }
    cursor = users[users.length - 1]!.id;
    if (users.length < 100) break;
  }
  return { notificationsCreated: count };
}
