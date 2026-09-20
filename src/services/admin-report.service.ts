import { Prisma, ReportStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { disconnectUserSockets, safeBroadcast, safeEmit } from "../lib/socket";
import { settleCompletedBooking } from "./bookings/completion.service";
import { applyTrustEventInTransaction } from "./trust.service";
import { performImmediateCancel } from "./cancellation.service";
import { lockBookingLifecycle } from "./booking-lifecycle.service";
import {
  beginAdminResolution,
  completedResolutionResult,
  hasEstablishedFinancialEffect,
  markAdminResolutionFailed,
  markAdminResolutionStage,
  markAdminResolutionStageInTransaction,
} from "./admin-resolution-operation.service";
import { assertNoOtherBlockingCases, restoreBookingIfNoBlockingCases } from "./case-resolution.service";

export type ReportBookingOutcome = "dismiss" | "cancel_booking" | "release_provider_and_complete";
export type ReportPenaltyAction = "none" | "warn" | "trust_deduct" | "suspend" | "ban";
export type ReportAction = ReportBookingOutcome | ReportPenaltyAction | "approve_refund";

const reportInclude = {
  reporter: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
  reportedUser: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
  cancellationRequest: true,
  booking: { include: {
    seeker: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
    provider: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
    service: { select: { id: true, title: true, price: true } },
    offer: { include: { request: { select: { id: true, title: true } } } },
    directRequest: { include: { service: { select: { id: true, title: true } } } },
    _count: { select: { messages: true } },
    queue: true,
  } },
} as const;

function httpError(message: string, status: number, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

export async function listAdminReports(page = 1, limit = 10) {
  const where = { status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] } };
  const [reports, total] = await Promise.all([
    prisma.report.findMany({ where, include: reportInclude, orderBy: { createdAt: "asc" }, skip: (page - 1) * limit, take: limit }),
    prisma.report.count({ where }),
  ]);
  const operations = await prisma.adminResolutionOperation.findMany({ where: { OR: [
    { caseType: "REPORT", caseId: { in: reports.map((report) => report.id) } },
    { caseType: "CANCELLATION", caseId: { in: reports.flatMap((report) => report.cancellationRequest ? [report.cancellationRequest.id] : []) } },
  ] } });
  const byCase = new Map(operations.map((operation) => [operation.caseId, operation]));
  const items = reports.map((report) => {
    const { evidenceStorageKey, cancellationRequest, ...safeReport } = report;
    const { _count, ...safeBooking } = report.booking;
    return {
      ...safeReport,
      hasPrivateEvidence: Boolean(evidenceStorageKey),
      resolutionOperation: byCase.get(cancellationRequest?.id || report.id) || null,
      booking: {
        ...safeBooking,
        title: report.booking.service?.title || report.booking.offer?.request.title || report.booking.directRequest?.service.title || "Service engagement",
        amount: Number(report.booking.agreedAmount || report.booking.directRequest?.agreedPrice || report.booking.offer?.offeredPrice || report.booking.service?.price || 0),
        messageCount: _count.messages,
        escalatedCancellation: cancellationRequest || null,
      },
    };
  });
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

function activityLink(report: { booking: { seekerId: string; providerId: string } }, userId: string, tab = "all") {
  return userId === report.booking.providerId ? `/provider/provider-activity?tab=${tab}` : `/seeker/seeker-activity?tab=${tab}`;
}

async function applyReportPenalty(tx: Prisma.TransactionClient, report: { id: string; reportedUserId: string }, adminId: string, penalty: ReportPenaltyAction, notes: string) {
  if (penalty === "trust_deduct") {
    await applyTrustEventInTransaction(tx, { userId: report.reportedUserId, delta: -10, reason: "Valid report confirmed by administrator", actorAdminId: adminId, eventKey: `report:${report.id}:trust-penalty` });
  } else if (penalty === "suspend" || penalty === "ban") {
    const blockers = await tx.booking.count({ where: { providerId: report.reportedUserId, started: false, status: { in: ["PENDING_APPROVAL", "WAITING", "ACCEPTED"] } } });
    if (blockers > 0) throw httpError(`Resolve or administratively cancel the provider's ${blockers} unstarted booking(s) before suspension or banning`, 409);
    await tx.user.update({ where: { id: report.reportedUserId }, data: { isActive: true, moderationStatus: penalty === "ban" ? "BANNED" : "SUSPENDED", suspendedUntil: penalty === "suspend" ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null, moderationReason: notes } });
  }
}

async function reserveReportFinancialOutcome(operationId: string, reportId: string) {
  return prisma.$transaction(async (tx) => {
    const initial = await tx.report.findUnique({ where: { id: reportId }, select: { bookingId: true } });
    if (!initial) throw httpError("Report not found", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const report = await tx.report.findUnique({ where: { id: reportId } });
    const operation = await tx.adminResolutionOperation.findUnique({ where: { id: operationId } });
    if (!report || report.status !== "UNDER_REVIEW") throw httpError("Report changed before its financial outcome was reserved", 409, "STALE_REPORT");
    if (!operation) throw httpError("Resolution operation not found", 500);
    if (operation.status === "COMPLETED") return operation;
    if (hasEstablishedFinancialEffect(operation)) return operation;
    await assertNoOtherBlockingCases(tx, report.bookingId, { reportId: report.id });
    return markAdminResolutionStageInTransaction(tx, operation.id, "FINANCIAL_EFFECT_RESERVED");
  });
}

export async function resolveAdminReport(reportId: string, adminId: string, action: ReportAction, adminNotes: string, requestedPenalty: ReportPenaltyAction = "none") {
  if (action === "warn" || action === "trust_deduct" || action === "suspend" || action === "ban" || action === "none") throw httpError("Choose a booking outcome; a moderation penalty cannot resolve a disputed booking by itself", 422, "BOOKING_OUTCOME_REQUIRED");
  const outcome: ReportBookingOutcome = action === "approve_refund" ? "cancel_booking" : action;

  const claim = await prisma.$transaction(async (tx) => {
    const initial = await tx.report.findUnique({ where: { id: reportId } });
    if (!initial) throw httpError("Report not found", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const report = await tx.report.findUnique({ where: { id: reportId }, include: { booking: true } });
    if (!report) throw httpError("Report not found", 404);
    if (report.reportType === "CANCELLATION_ESCALATION") throw httpError("Use the linked cancellation decision controls for this case", 422, "USE_CANCELLATION_RESOLUTION");
    const existingOperation = await tx.adminResolutionOperation.findUnique({ where: { caseType_caseId: { caseType: "REPORT", caseId: report.id } } });
    if (!["PENDING", "UNDER_REVIEW"].includes(report.status)) {
      if (existingOperation?.status === "COMPLETED") return { report, operation: existingOperation, completed: existingOperation.result };
      throw httpError("Report has already been resolved", 409);
    }
    const operation = await beginAdminResolution(tx, { caseType: "REPORT", caseId: report.id, bookingId: report.bookingId, adminId, outcome, penalty: requestedPenalty, notes: adminNotes });
    const completed = completedResolutionResult(operation);
    if (completed) return { report, operation, completed };
    const effectEstablished = hasEstablishedFinancialEffect(operation);
    if (!effectEstablished && outcome === "release_provider_and_complete" && (report.reportType !== "COMPLETION_DISPUTE" || report.booking.statusBeforeDispute !== "AWAITING_CONFIRMATION")) throw httpError("Only a completion dispute awaiting seeker confirmation can be released to the provider", 422, "INVALID_REPORT_OUTCOME");
    if (!effectEstablished && outcome !== "dismiss") {
      await assertNoOtherBlockingCases(tx, report.bookingId, { reportId: report.id });
    }
    await tx.report.update({ where: { id: report.id }, data: { status: "UNDER_REVIEW", adminId, adminNotes } });
    return { report, operation, completed: null };
  });
  if (claim.completed) return claim.completed;

  try {
    const effectAlreadyEstablished = hasEstablishedFinancialEffect(claim.operation);
    if (outcome === "cancel_booking" && !effectAlreadyEstablished) {
      await reserveReportFinancialOutcome(claim.operation.id, reportId);
      await performImmediateCancel(claim.report.bookingId, adminId);
      await markAdminResolutionStage(claim.operation.id, "FINANCIAL_EFFECT_ESTABLISHED");
    } else if (outcome === "release_provider_and_complete" && !effectAlreadyEstablished) {
      await reserveReportFinancialOutcome(claim.operation.id, reportId);
      await settleCompletedBooking(claim.report.bookingId, { type: "ADMIN", userId: adminId });
      await markAdminResolutionStage(claim.operation.id, "FINANCIAL_EFFECT_ESTABLISHED");
    } else {
      await markAdminResolutionStage(claim.operation.id, "DECISION_READY");
    }

    const finalized = await prisma.$transaction(async (tx) => {
      await lockBookingLifecycle(tx, claim.report.bookingId);
      const operation = await tx.adminResolutionOperation.findUnique({ where: { id: claim.operation.id } });
      if (!operation) throw httpError("Resolution operation not found", 500);
      if (operation.status === "COMPLETED") return { result: operation.result, reportedUserId: claim.report.reportedUserId, reporterId: claim.report.reporterId };
      const report = await tx.report.findUnique({ where: { id: reportId }, include: { booking: true } });
      if (!report || report.status !== "UNDER_REVIEW") throw httpError("Report changed before finalization", 409);

      if (outcome === "cancel_booking") {
        const valid = report.booking.status === "CANCELED" && (report.booking.paymentMethod === "On-site Cash" ? report.booking.paymentStatus === "UNPAID" : report.booking.paymentStatus === "REFUNDED");
        if (!valid) throw httpError("Booking cancellation/refund has not reached a valid final state", 409);
      } else if (outcome === "release_provider_and_complete") {
        if (report.booking.status !== "COMPLETED" || !["RELEASED", "CASH_CONFIRMED"].includes(report.booking.paymentStatus)) throw httpError("Booking completion has not reached a valid final state", 409);
      }

      await applyReportPenalty(tx, report, adminId, requestedPenalty, adminNotes);
      const finalStatus = outcome === "dismiss" ? "DISMISSED" : "RESOLVED";
      await tx.report.update({ where: { id: report.id }, data: { status: finalStatus, adminId, adminNotes, resolvedAt: new Date() } });
      if (outcome === "dismiss") await restoreBookingIfNoBlockingCases(tx, report.bookingId);
      const outcomeLabel = outcome.replace(/_/g, " ");
      const penaltyLabel = requestedPenalty === "none" ? "No additional account penalty." : `Additional action: ${requestedPenalty.replace(/_/g, " ")}.`;
      await tx.notification.createMany({ data: [
        { userId: report.reporterId, title: "Report resolved", body: `Booking outcome: ${outcomeLabel}. ${penaltyLabel} ${adminNotes}`, link: `${activityLink(report, report.reporterId)}&booking=${report.bookingId}` },
        { userId: report.reportedUserId, title: requestedPenalty === "warn" ? "Official administrator warning" : "Report resolved", body: `Booking outcome: ${outcomeLabel}. ${penaltyLabel} ${adminNotes}`, link: `${activityLink(report, report.reportedUserId)}&booking=${report.bookingId}` },
      ] });
      await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: report.reportedUserId, action: `REPORT_${outcome.toUpperCase()}`, resourceType: "Report", resourceId: report.id, reason: adminNotes, metadata: { bookingId: report.bookingId, outcome, penaltyAction: requestedPenalty, operationId: operation.id } } });
      const result = { resolved: true, outcome, penaltyAction: requestedPenalty, operationId: operation.id };
      await tx.adminResolutionOperation.update({ where: { id: operation.id }, data: { status: "COMPLETED", stage: "CASE_FINALIZED", result, completedAt: new Date(), lastError: null } });
      return { result, reportedUserId: report.reportedUserId, reporterId: report.reporterId };
    });
    if (["suspend", "ban"].includes(requestedPenalty)) await disconnectUserSockets(finalized.reportedUserId, "Your account moderation status changed.");
    safeEmit(`user:${finalized.reporterId}`, "notification", { title: "Report resolved" });
    safeEmit(`user:${finalized.reportedUserId}`, "notification", { title: "Report resolved" });
    safeBroadcast("ADMIN_MODERATION_CHANGED", { reportId, outcome, penaltyAction: requestedPenalty });
    return finalized.result;
  } catch (cause) {
    await markAdminResolutionFailed(claim.operation.id, cause);
    throw cause;
  }
}
