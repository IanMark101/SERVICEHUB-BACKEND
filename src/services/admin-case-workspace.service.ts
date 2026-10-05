import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { reportInclude } from "./admin-report.service";
import { allowedReportOutcomes } from "./report-decision-policy";
import { lockBookingLifecycle } from "./booking-lifecycle.service";
import { safeEmit } from "../lib/socket";

export interface CaseFilters {
  page: number; limit: number; view: "active" | "history" | "all";
  concern?: string; type?: string; status?: string; payment?: string;
  search?: string; sort: "oldest" | "newest" | "attention"; userId?: string; bookingId?: string;
}

// A parameterized UNION pages the combined queue in the database. It does not
// fetch every report or quietly search only the current browser page.
const caseIndex = Prisma.sql`
  WITH cases AS (
    SELECT r.id, 'report' AS source, r."bookingId", r.status::text AS status,
      r."reportType" AS type, CASE WHEN r."reportType" = 'CANCELLATION_ESCALATION' THEN 'CANCELLATION_REVIEW' ELSE r.reason::text END AS concern, r.description AS explanation,
      r."reporterId", r."reportedUserId", r."createdAt", r."resolvedAt"
    FROM reports r
    UNION ALL
    SELECT e.id, 'completion' AS source, e."bookingId", e.status,
      'COMPLETION_ESCALATION', 'COMPLETION_REVIEW', e.reason,
      e."requestedBy", b."seekerId", e."createdAt", e."resolvedAt"
    FROM completion_escalations e JOIN bookings b ON b.id = e."bookingId"
  ), indexed AS (
    SELECT c.*, b."paymentMethod", b."seekerId", b."providerId",
      seeker.name AS "seekerName", provider.name AS "providerName",
      COALESCE(s.title, sr.title, ds.title, 'Service engagement') AS title
    FROM cases c JOIN bookings b ON b.id = c."bookingId"
    JOIN users seeker ON seeker.id = b."seekerId"
    JOIN users provider ON provider.id = b."providerId"
    LEFT JOIN services s ON s.id = b."serviceId"
    LEFT JOIN offers o ON o.id = b."offerId"
    LEFT JOIN service_requests sr ON sr.id = o."requestId"
    LEFT JOIN direct_requests d ON d.id = b."directRequestId"
    LEFT JOIN services ds ON ds.id = d."serviceId"
  )`;

export function caseWhere(filters: CaseFilters, summary = false) {
  const clauses: Prisma.Sql[] = [];
  if (filters.userId) clauses.push(Prisma.sql`(i."seekerId" = ${filters.userId} OR i."providerId" = ${filters.userId} OR i."reporterId" = ${filters.userId} OR i."reportedUserId" = ${filters.userId})`);
  if (filters.bookingId) clauses.push(Prisma.sql`i."bookingId" = ${filters.bookingId}`);
  if (!summary) {
    if (filters.view !== "all") clauses.push(filters.view === "active" ? Prisma.sql`i.status IN ('PENDING', 'UNDER_REVIEW')` : Prisma.sql`i.status NOT IN ('PENDING', 'UNDER_REVIEW')`);
    if (filters.concern) clauses.push(Prisma.sql`i.concern = ${filters.concern}`);
    if (filters.type) clauses.push(Prisma.sql`i.type = ${filters.type}`);
    if (filters.status) clauses.push(Prisma.sql`i.status = ${filters.status}`);
    if (filters.payment) clauses.push(Prisma.sql`i."paymentMethod" = ${filters.payment}`);
    if (filters.search) {
      // Escape LIKE wildcards so user text is treated as a literal search.
      const term = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`;
      clauses.push(Prisma.sql`(i.id ILIKE ${term} OR i."bookingId" ILIKE ${term} OR i.title ILIKE ${term} OR i."seekerName" ILIKE ${term} OR i."providerName" ILIKE ${term} OR i.explanation ILIKE ${term} OR replace(i.concern, '_', ' ') ILIKE ${term} OR replace(i.type, '_', ' ') ILIKE ${term})`);
    }
  }
  return clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
}

type CaseKey = { id: string; source: string };
const bookingInclude = reportInclude.booking.include;

async function hydrate(keys: CaseKey[], full = false) {
  const reportIds = keys.filter(k => k.source === "report").map(k => k.id);
  const completionIds = keys.filter(k => k.source === "completion").map(k => k.id);
  const [reports, escalations] = await Promise.all([
    reportIds.length ? prisma.report.findMany({ where: { id: { in: reportIds } }, include: reportInclude }) : [],
    completionIds.length ? prisma.completionEscalation.findMany({ where: { id: { in: completionIds } }, include: { booking: { include: bookingInclude } } }) : [],
  ]);
  const operationIds = [...reportIds, ...completionIds, ...reports.flatMap(r => r.cancellationRequest ? [r.cancellationRequest.id] : [])];
  const operations = operationIds.length ? await prisma.adminResolutionOperation.findMany({ where: { caseId: { in: operationIds }, caseType: { in: ["REPORT", "CANCELLATION", "COMPLETION_ESCALATION"] } } }) : [];
  const byKey = new Map<string, ReturnType<typeof normalize>>();
  function normalize(item: typeof reports[number] | typeof escalations[number], source: string) {
    const report = source === "report" ? item as typeof reports[number] : null;
    const escalation = source === "completion" ? item as typeof escalations[number] : null;
    const booking = item.booking;
    const operationId = report?.cancellationRequest?.id || item.id;
    const operation = operations.find(o => o.caseId === operationId);
    const active = ["PENDING", "UNDER_REVIEW"].includes(item.status);
    let outcomes = report ? allowedReportOutcomes(report) : active ? ["keep_awaiting", "refund_seeker", "release_provider_and_complete"] : [];
    if (report?.reportType === "CANCELLATION_ESCALATION") outcomes = active && report.cancellationRequest ? ["approve_cancellation", "deny_cancellation"] : [];
    if (operation && ["PROCESSING", "FAILED_RETRYABLE"].includes(operation.status)) {
      const requested = operation.requestedOutcome === "ADMIN_APPROVE" ? "approve_cancellation" : operation.requestedOutcome === "ADMIN_DENY" ? "deny_cancellation" : operation.requestedOutcome;
      outcomes = [requested];
    }
    return {
      id: item.id, source, type: report?.reportType || "COMPLETION_ESCALATION",
      concern: report?.reportType === "CANCELLATION_ESCALATION" ? "CANCELLATION_REVIEW" : report?.reason || "COMPLETION_REVIEW",
      status: item.status, createdAt: item.createdAt, resolvedAt: item.resolvedAt,
      explanation: full ? report?.description || escalation?.reason || "" : (report?.description || escalation?.reason || "").slice(0, 220),
      reporter: report?.reporter || booking.provider,
      reportedUser: report?.reportedUser || null,
      submittedByRole: (report?.reporterId || escalation?.requestedBy) === booking.seekerId ? "Seeker" : "Provider",
      booking: { id: booking.id, title: booking.service?.title || booking.offer?.request.title || booking.directRequest?.service.title || "Service engagement", amount: Number(booking.agreedAmount || 0), status: booking.status, started: booking.started, statusBeforeDispute: booking.statusBeforeDispute, paymentStatus: booking.paymentStatus, paymentMethod: booking.paymentMethod, seeker: booking.seeker, provider: booking.provider, queue: booking.queue ? { status: booking.queue.status, position: booking.queue.position } : null, messageCount: booking._count.messages },
      hasPrivateEvidence: Boolean(report?.evidenceStorageKey), evidenceUrl: full ? report?.evidenceUrl : undefined,
      cancellation: report?.cancellationRequest ? { id: report.cancellationRequest.id, reason: report.cancellationRequest.reason, response: report.cancellationRequest.providerNote, status: report.cancellationRequest.status, resolutionOutcome: report.cancellationRequest.resolutionOutcome } : null,
      allowedOutcomes: outcomes,
      resolutionOperation: operation ? { status: operation.status, stage: operation.stage, requestedOutcome: operation.requestedOutcome, requestedPenalty: operation.requestedPenalty, notes: full ? operation.notes : undefined, lastError: operation.lastError } : null,
      decisionExplanation: full ? report?.adminNotes : undefined,
      resolution: escalation?.resolution,
    };
  }
  for (const report of reports) byKey.set(`report:${report.id}`, normalize(report, "report"));
  for (const item of escalations) byKey.set(`completion:${item.id}`, normalize(item, "completion"));
  return keys.flatMap(k => { const item = byKey.get(`${k.source}:${k.id}`); return item ? [item] : []; });
}

export async function listModerationCases(filters: CaseFilters) {
  const where = caseWhere(filters);
  const summaryWhere = caseWhere(filters, true);
  const dateOrder = filters.view === 'history' ? Prisma.sql`COALESCE(i."resolvedAt", i."createdAt")` : Prisma.sql`i."createdAt"`;
  const order = filters.sort === "newest" ? Prisma.sql`${dateOrder} DESC` : filters.sort === "attention" && filters.view !== 'history' ? Prisma.sql`CASE WHEN i.status = 'PENDING' THEN 0 WHEN i.status = 'UNDER_REVIEW' THEN 1 ELSE 2 END, i."createdAt" ASC` : Prisma.sql`${dateOrder} ASC`;
  const [keys, totals, summary] = await prisma.$transaction([
    prisma.$queryRaw<CaseKey[]>(Prisma.sql`${caseIndex} SELECT i.id, i.source FROM indexed i ${where} ORDER BY ${order}, i.source, i.id LIMIT ${filters.limit} OFFSET ${(filters.page - 1) * filters.limit}`),
    prisma.$queryRaw<{ total: bigint }[]>(Prisma.sql`${caseIndex} SELECT COUNT(*) AS total FROM indexed i ${where}`),
    prisma.$queryRaw<{ status: string; concern: string; total: bigint }[]>(Prisma.sql`${caseIndex} SELECT i.status, CASE WHEN i.type = 'CANCELLATION_ESCALATION' THEN 'CANCELLATION_REVIEW' ELSE i.concern END AS concern, COUNT(*) AS total FROM indexed i ${summaryWhere} GROUP BY i.status, concern, i.type`),
  ]);
  const total = Number(totals[0]?.total || 0);
  const counts = { active: 0, underReview: 0, history: 0, concerns: {} as Record<string, number> };
  for (const row of summary) {
    const count = Number(row.total);
    if (["PENDING", "UNDER_REVIEW"].includes(row.status)) { counts.active += count; counts.concerns[row.concern] = (counts.concerns[row.concern] || 0) + count; }
    else counts.history += count;
    if (row.status === "UNDER_REVIEW") counts.underReview += count;
  }
  return { items: await hydrate(keys), summary: counts, pagination: { page: filters.page, limit: filters.limit, total, totalPages: Math.ceil(total / filters.limit) } };
}

export async function getModerationCase(source: string, id: string) {
  const item = (await hydrate([{ source, id }], true))[0];
  if (!item) throw Object.assign(new Error("Case not found"), { status: 404 });
  const resourceIds = [id, item.booking.id, ...(item.cancellation ? [item.cancellation.id] : [])];
  const [history, reportCount, cancellationCount, escalationCount] = await Promise.all([
    prisma.adminAuditLog.findMany({ where: { OR: [{ resourceId: { in: resourceIds } }, { resourceType: "Booking", resourceId: item.booking.id }] }, select: { id: true, action: true, reason: true, createdAt: true, actor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.report.count({ where: { bookingId: item.booking.id, status: { in: ["PENDING", "UNDER_REVIEW"] }, ...(source === "report" ? { id: { not: id } } : {}) } }),
    prisma.cancellationRequest.count({ where: { bookingId: item.booking.id, status: { in: ["PENDING", "DECLINED", "ESCALATED", "UNDER_REVIEW"] }, ...(item.cancellation ? { id: { not: item.cancellation.id } } : {}) } }),
    prisma.completionEscalation.count({ where: { bookingId: item.booking.id, status: { in: ["PENDING", "UNDER_REVIEW"] }, ...(source === "completion" ? { id: { not: id } } : {}) } }),
  ]);
  return { ...item, history, otherBlockingCases: reportCount + cancellationCount + escalationCount };
}

export async function startModerationReview(source: string, id: string, adminId: string) {
  const changed = await prisma.$transaction(async tx => {
    const initial = source === "report" ? await tx.report.findUnique({ where: { id } }) : await tx.completionEscalation.findUnique({ where: { id } });
    if (!initial) throw Object.assign(new Error("Case not found"), { status: 404 });
    await lockBookingLifecycle(tx, initial.bookingId);
    const changed = source === "report"
      ? await tx.report.updateMany({ where: { id, status: "PENDING" }, data: { status: "UNDER_REVIEW", adminId } })
      : await tx.completionEscalation.updateMany({ where: { id, status: "PENDING" }, data: { status: "UNDER_REVIEW", adminId } });
    if (changed.count) {
      if (source === "report") await tx.cancellationRequest.updateMany({ where: { reportId: id, status: "ESCALATED" }, data: { status: "UNDER_REVIEW" } });
      await tx.adminAuditLog.create({ data: { actorId: adminId, action: "CASE_REVIEW_STARTED", resourceType: source === "report" ? "Report" : "CompletionEscalation", resourceId: id, reason: "Administrator opened the case for review", metadata: { bookingId: initial.bookingId } } });
    }
    return changed.count > 0;
  });
  if (changed) safeEmit("admin", "ADMIN_MODERATION_CHANGED", { caseId: id });
  return getModerationCase(source, id);
}
