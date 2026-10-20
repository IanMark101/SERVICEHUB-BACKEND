import { Prisma } from '@prisma/client';
import type { PlatformEarningsQuery } from '../schema/platform-earnings.schema';

export function earningsDates(query: PlatformEarningsQuery, now = new Date()) {
  const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  const day = new Date(today + 'T00:00:00Z');
  const week = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  const month = today.slice(0, 7) + '-01';
  return { today, week, month, from: query.period === 'custom' ? query.from! : query.period === 'today' ? today : query.period === 'week' ? week : month, to: query.period === 'custom' ? query.to! : today };
}

/** One SQL snapshot for totals, chart and a bounded page. No per-row queries. */
export function platformEarningsSql(query: PlatformEarningsQuery, now = new Date()) {
  const dates = earningsDates(query, now);
  return Prisma.sql`
    WITH records AS (
      SELECT a.id, b.id AS "bookingId", a."providerIntentId" AS reference,
        COALESCE(r.title, s.title, 'Previous service booking') AS "serviceTitle",
        COALESCE(customer.name, 'Deleted account') AS "customerName",
        COALESCE(provider.name, 'Deleted account') AS "providerName",
        a.amount, a."platformFeeAmount", COALESCE(a."providerNetAmount", a.amount) AS "providerNetAmount",
        a."commissionRateBps", a."isTestMode", a."paidAt",
        COALESCE(cs."completedAt", a."paidAt", a."createdAt") AS "recordedAt",
        CASE
          WHEN a.status = 'REFUNDED' OR b."paymentStatus" = 'REFUNDED' THEN 'refunded'
          WHEN a.status = 'REFUND_REQUIRED' OR b."paymentStatus" = 'FROZEN_HELD' THEN 'review'
          WHEN a.status IN ('FAILED', 'EXPIRED') THEN 'failed'
          WHEN a.status = 'SUCCEEDED' AND b.status = 'COMPLETED' AND b."paymentStatus" = 'RELEASED'
            AND cs."paymentStatus" = 'RELEASED' THEN 'earned'
          WHEN a.status = 'SUCCEEDED' THEN 'held'
          ELSE 'pending' END AS status,
        CASE WHEN a.status = 'SUCCEEDED' AND b.status = 'COMPLETED'
          AND b."paymentStatus" = 'RELEASED' AND cs."paymentStatus" = 'RELEASED'
          THEN cs."platformFeeAmount" ELSE 0 END AS "earnedFee"
      FROM payment_attempts a
      LEFT JOIN bookings b ON b."paymentAttemptId" = a.id AND b."paymentMethod" = 'GCash'
      LEFT JOIN completed_services cs ON cs."bookingId" = b.id
      LEFT JOIN services s ON s.id = a."serviceId"
      LEFT JOIN offers o ON o.id = a."offerId"
      LEFT JOIN service_requests r ON r.id = o."requestId"
      LEFT JOIN users customer ON customer.id = a."seekerId"
      LEFT JOIN users provider ON provider.id = a."providerId"
      WHERE a."paymentMethod" = 'gcash'
    ), dated AS (
      SELECT *, ("recordedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date AS day FROM records
    ), ranged AS (
      SELECT * FROM dated WHERE day BETWEEN ${dates.from}::date AND ${dates.to}::date
    ), filtered AS (
      SELECT *, row_number() OVER (ORDER BY "recordedAt" DESC, id DESC) AS ordinal
      FROM ranged WHERE (${query.status} = 'all' OR status = ${query.status})
    ), meta AS (
      SELECT count(*)::int AS total, GREATEST(1, CEIL(count(*)::numeric / ${query.limit}))::int AS "totalPages",
        LEAST(${query.page}, GREATEST(1, CEIL(count(*)::numeric / ${query.limit})))::int AS page FROM filtered
    )
    SELECT json_build_object(
      'earnedTotal', COALESCE(SUM("earnedFee"), 0),
      'today', COALESCE(SUM("earnedFee") FILTER (WHERE day = ${dates.today}::date), 0),
      'week', COALESCE(SUM("earnedFee") FILTER (WHERE day >= ${dates.week}::date AND day <= ${dates.today}::date), 0),
      'month', COALESCE(SUM("earnedFee") FILTER (WHERE day >= ${dates.month}::date AND day <= ${dates.today}::date), 0),
      'pendingFees', COALESCE(SUM("platformFeeAmount") FILTER (WHERE status IN ('held', 'review')), 0)
    ) AS summary,
    (SELECT json_build_object(
      'transactions', count(*), 'paidTransactions', count(*) FILTER (WHERE status IN ('earned','held','review')),
      'earnedFees', COALESCE(SUM("earnedFee"), 0),
      'averageFee', COALESCE(AVG("earnedFee") FILTER (WHERE status = 'earned'), 0)
    ) FROM ranged) AS period,
    (SELECT json_build_object('from', ${dates.from}::text, 'to', ${dates.to}::text, 'timezone', 'Asia/Manila')) AS range,
    (SELECT json_build_object('page', page, 'limit', ${query.limit}::int, 'total', total, 'totalPages', "totalPages") FROM meta) AS pagination,
    COALESCE((SELECT json_agg(json_build_object('date', to_char(days.day, 'YYYY-MM-DD'), 'amount', COALESCE(t.amount, 0)) ORDER BY days.day)
      FROM generate_series(${dates.from}::date, ${dates.to}::date, interval '1 day') AS days(day)
      LEFT JOIN (SELECT day, SUM("earnedFee") AS amount FROM ranged GROUP BY day) t ON t.day = days.day::date), '[]'::json) AS trend,
    COALESCE((SELECT json_agg(json_build_object(
      'id', id, 'bookingId', "bookingId", 'reference', reference, 'serviceTitle', "serviceTitle",
      'customerName', "customerName", 'providerName', "providerName", 'amount', amount,
      'platformFeeAmount', "platformFeeAmount", 'providerNetAmount', "providerNetAmount",
      'commissionRateBps', "commissionRateBps", 'status', status, 'isTestMode', "isTestMode",
      'recordedAt', to_char("recordedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'paidAt', CASE WHEN "paidAt" IS NULL THEN NULL ELSE to_char("paidAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ) ORDER BY ordinal) FROM filtered, meta
      WHERE ordinal > (meta.page - 1) * ${query.limit} AND ordinal <= meta.page * ${query.limit}), '[]'::json) AS items
    FROM dated;
  `;
}
