import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { subscriptionBenefits, subscriptionSelect } from './subscription-policy';

export async function getProviderAnalytics(providerId: string, now = new Date()) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: providerId }, select: subscriptionSelect });
  const benefits = subscriptionBenefits(user, now);
  if (!benefits.fullAnalytics) return { level: 'BASIC' as const, days: 30, daily: null, summary: null };
  const local = new Date(now.getTime() + 8 * 3_600_000);
  const from = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - 29) - 8 * 3_600_000);
  const rows = await prisma.$queryRaw<Array<{ day: string; completed: number; earned: Prisma.Decimal; cash: Prisma.Decimal; gcash: Prisma.Decimal; fees: Prisma.Decimal }>>`
    SELECT to_char(cs."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day,
      count(*)::int AS completed,
      sum(COALESCE(cs."providerNetAmount", cs."finalPrice")) AS earned,
      COALESCE(sum(COALESCE(cs."providerNetAmount", cs."finalPrice")) FILTER (WHERE cs."paymentStatus" = 'CASH_CONFIRMED'), 0) AS cash,
      COALESCE(sum(COALESCE(cs."providerNetAmount", cs."finalPrice")) FILTER (WHERE cs."paymentStatus" = 'RELEASED'), 0) AS gcash,
      sum(cs."platformFeeAmount") AS fees
    FROM completed_services cs LEFT JOIN bookings b ON b.id = cs."bookingId"
    WHERE cs."providerId" = ${providerId} AND cs."seekerId" <> ${providerId}
      AND cs."completedAt" >= ${from} AND cs."completedAt" <= ${now}
      AND cs."paymentStatus" IN ('RELEASED', 'CASH_CONFIRMED')
      AND (b.id IS NULL OR (b.status = 'COMPLETED' AND b."paymentStatus" = cs."paymentStatus"))
    GROUP BY day ORDER BY day DESC`;
  const sum = (key: 'earned' | 'cash' | 'gcash' | 'fees') => Number(rows.reduce((total, row) => total.plus(row[key]), new Prisma.Decimal(0)));
  const completed = rows.reduce((total, row) => total + row.completed, 0);
  return { level: 'FULL' as const, days: 30, from, to: now,
    summary: { earned: sum('earned'), cash: sum('cash'), gcash: sum('gcash'), fees: sum('fees'), completed,
      averagePerBooking: completed ? Number(new Prisma.Decimal(sum('earned')).div(completed).toDecimalPlaces(2)) : 0 },
    daily: rows.map(row => ({ day: row.day, completed: row.completed, earned: Number(row.earned) })) };
}
