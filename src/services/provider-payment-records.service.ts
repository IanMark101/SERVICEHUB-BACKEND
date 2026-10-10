import { Prisma } from '@prisma/client';
import type { ProviderPaymentRecordsQuery } from '../schema/provider-payment-records.schema';

export interface ProviderPaymentRecord {
  id: string;
  bookingId: string | null;
  serviceTitle: string;
  seekerName: string;
  paymentMethod: string;
  outcome: 'completed' | 'refunded' | 'cancelled';
  paymentStatus: string;
  amount: number;
  earnedAmount: number;
  recordedAt: string;
}

export interface ProviderPaymentRecordsResult {
  items: ProviderPaymentRecord[];
  summary: { earnedTotal: number; cashTotal: number; onlineTotal: number; completedCount: number };
  pagination: { page: number; limit: number; total: number; totalPages: number };
  linkedRecordFound: boolean;
}

/** A read-only booking projection, independent of the member's wallet ledger.
 * REFUND rows belong to seekers; cash completion has no wallet transaction.
 * SQL sums exact Decimal snapshots before converting the response to JSON. */
export function providerPaymentRecordsSql(providerId: string, query: ProviderPaymentRecordsQuery) {
  return Prisma.sql`
    WITH records AS (
      SELECT b.id, b.id AS "bookingId",
        COALESCE(r.title, s.title, ds.title, 'Previous service booking') AS "serviceTitle",
        u.name AS "seekerName", b."paymentMethod", b.status::text AS "bookingStatus",
        COALESCE(cs."paymentStatus", b."paymentStatus")::text AS "paymentStatus",
        CASE WHEN b."paymentStatus" = 'REFUNDED' THEN COALESCE(refund.amount, b."agreedAmount", 0)
          ELSE COALESCE(cs."finalPrice", b."agreedAmount", 0) END AS amount,
        CASE WHEN b.status = 'COMPLETED' AND cs.id IS NOT NULL
          AND cs."paymentStatus" IN ('RELEASED', 'CASH_CONFIRMED')
          AND b."paymentStatus" = cs."paymentStatus"
          THEN cs."finalPrice" ELSE 0 END AS "earnedAmount",
        COALESCE(cs."completedAt", progress."occurredAt", b."updatedAt") AS "recordedAt"
      FROM bookings b
      JOIN users u ON u.id = b."seekerId"
      LEFT JOIN completed_services cs ON cs."bookingId" = b.id AND cs."providerId" = b."providerId"
      LEFT JOIN services s ON s.id = b."serviceId"
      LEFT JOIN offers o ON o.id = b."offerId"
      LEFT JOIN service_requests r ON r.id = o."requestId"
      LEFT JOIN direct_requests dr ON dr.id = b."directRequestId"
      LEFT JOIN services ds ON ds.id = dr."serviceId"
      LEFT JOIN payment_refunds refund ON refund."bookingId" = b.id
      LEFT JOIN LATERAL (
        SELECT MAX("occurredAt") AS "occurredAt" FROM booking_progress_events
        WHERE "bookingId" = b.id AND kind IN ('CANCELED', 'DECLINED')
      ) progress ON true
      WHERE b."providerId" = ${providerId} AND b."seekerId" <> ${providerId}
        AND b.status IN ('COMPLETED', 'CANCELED', 'DECLINED', 'REMOVED')
      UNION ALL
      SELECT cs.id, NULL::text AS "bookingId",
        COALESCE(r.title, s.title, ds.title, 'Previous service booking'),
        u.name, CASE WHEN cs."paymentStatus" = 'CASH_CONFIRMED' THEN 'On-site Cash' ELSE 'GCash' END,
        'COMPLETED', cs."paymentStatus"::text, cs."finalPrice",
        CASE WHEN cs."paymentStatus" IN ('RELEASED', 'CASH_CONFIRMED') THEN cs."finalPrice" ELSE 0 END,
        cs."completedAt"
      FROM completed_services cs
      JOIN users u ON u.id = cs."seekerId"
      LEFT JOIN offers o ON o.id = cs."offerId"
      LEFT JOIN service_requests r ON r.id = o."requestId"
      LEFT JOIN queue q ON q.id = cs."queueId"
      LEFT JOIN services s ON s.id = q."serviceId"
      LEFT JOIN direct_requests dr ON dr.id = cs."directRequestId"
      LEFT JOIN services ds ON ds.id = dr."serviceId"
      WHERE cs."providerId" = ${providerId} AND cs."seekerId" <> ${providerId} AND cs."bookingId" IS NULL
    ), classified AS (
      SELECT *, CASE WHEN "paymentStatus" = 'REFUNDED' THEN 'refunded'
        WHEN "bookingStatus" = 'COMPLETED' THEN 'completed' ELSE 'cancelled' END AS outcome
      FROM records
    ), filtered AS (
      SELECT *, row_number() OVER (ORDER BY "recordedAt" DESC, id DESC) AS ordinal
      FROM classified
      WHERE (${query.status} = 'all' OR outcome = ${query.status})
        AND (${query.date ?? null}::text IS NULL
          OR ("recordedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date = ${query.date ?? null}::date)
    ), meta AS (
      SELECT count(*)::int AS total,
        COALESCE(MAX(CEIL(ordinal::numeric / ${query.limit}))
          FILTER (WHERE "bookingId" = ${query.booking ?? null} OR id = ${query.booking ?? null}),
          LEAST(${query.page}, GREATEST(1, CEIL(count(*)::numeric / ${query.limit}))))::int AS page,
        GREATEST(1, CEIL(count(*)::numeric / ${query.limit}))::int AS "totalPages",
        COALESCE(bool_or("bookingId" = ${query.booking ?? null} OR id = ${query.booking ?? null}), false) AS "linkedRecordFound"
      FROM filtered
    )
    SELECT json_build_object(
      'earnedTotal', COALESCE(SUM("earnedAmount"), 0),
      'cashTotal', COALESCE(SUM("earnedAmount") FILTER (WHERE "paymentStatus" = 'CASH_CONFIRMED'), 0),
      'onlineTotal', COALESCE(SUM("earnedAmount") FILTER (WHERE "paymentStatus" = 'RELEASED'), 0),
      'completedCount', COUNT(*) FILTER (WHERE "earnedAmount" > 0)
    ) AS summary,
    (SELECT json_build_object('page', page, 'limit', ${query.limit}::int, 'total', total, 'totalPages', "totalPages") FROM meta) AS pagination,
    (SELECT "linkedRecordFound" FROM meta) AS "linkedRecordFound",
    COALESCE((SELECT json_agg(json_build_object(
      'id', id, 'bookingId', "bookingId", 'serviceTitle', "serviceTitle", 'seekerName', "seekerName",
      'paymentMethod', "paymentMethod", 'outcome', outcome, 'paymentStatus', "paymentStatus",
      'amount', amount, 'earnedAmount', "earnedAmount",
      'recordedAt', to_char("recordedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) ORDER BY ordinal) FROM filtered, meta
      WHERE ordinal > (meta.page - 1) * ${query.limit} AND ordinal <= meta.page * ${query.limit}), '[]'::json) AS items
    FROM classified`;
}

export async function getProviderPaymentRecords(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  providerId: string,
  query: ProviderPaymentRecordsQuery,
): Promise<ProviderPaymentRecordsResult> {
  const [result] = await db.$queryRaw<ProviderPaymentRecordsResult[]>(providerPaymentRecordsSql(providerId, query));
  return result;
}
