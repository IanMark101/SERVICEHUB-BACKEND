import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import { sendMessage } from "./messages.service";
import { refundBookingPayment } from "./payment-refund.service";
import { assertNoRefundInProgress, lockBookingLifecycle } from "./booking-lifecycle.service";
import {
  emitWaitlistNotification,
  lockServiceQueue,
  notifyWaitlistInTransaction,
  recalculateQueueInTransaction,
  type WaitlistNotification,
} from "./queue.service";
import {
  beginAdminResolution,
  completedResolutionResult,
  hasEstablishedFinancialEffect,
  markAdminResolutionFailed,
  markAdminResolutionStage,
  markAdminResolutionStageInTransaction,
} from "./admin-resolution-operation.service";
import {
  assertNoFinancialResolutionReserved,
  assertNoOtherBlockingCases,
  restoreBookingIfNoBlockingCases,
} from "./case-resolution.service";

const ACTIVE_CANCELLATION_STATUSES = ["PENDING", "DECLINED", "ESCALATED", "UNDER_REVIEW"];

function httpError(message: string, status: number, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

async function reserveCancellationFinancialOutcome(operationId: string, requestId: string) {
  return prisma.$transaction(async (tx) => {
    const initial = await tx.cancellationRequest.findUnique({ where: { id: requestId }, select: { bookingId: true } });
    if (!initial) throw httpError("Cancellation request not found", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const request = await tx.cancellationRequest.findUnique({ where: { id: requestId } });
    const operation = await tx.adminResolutionOperation.findUnique({ where: { id: operationId } });
    if (!request || request.status !== "UNDER_REVIEW") throw httpError("Cancellation case changed before its financial outcome was reserved", 409, "STALE_CANCELLATION");
    if (!operation) throw httpError("Resolution operation not found", 500);
    if (operation.status === "COMPLETED") return operation;
    if (hasEstablishedFinancialEffect(operation)) return operation;
    await assertNoOtherBlockingCases(tx, request.bookingId, {
      cancellationRequestId: request.id,
      reportId: request.reportId || undefined,
    });
    return markAdminResolutionStageInTransaction(tx, operation.id, "FINANCIAL_EFFECT_RESERVED");
  });
}

export async function performImmediateCancel(bookingId: string, actorId?: string, preStartRequestId?: string) {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { queue: true, service: true, offer: true, directRequest: true } });
  if (!booking || booking.status === "CANCELED") return;
  if (["COMPLETED", "DECLINED", "REMOVED"].includes(booking.status)) throw httpError("This booking can no longer be cancelled", 409);
  if (preStartRequestId) {
    const reservation = await prisma.cancellationRequest.findUnique({ where: { id: preStartRequestId } });
    if (!reservation || reservation.bookingId !== bookingId || reservation.status !== "UNDER_REVIEW" || reservation.resolutionOutcome !== "IMMEDIATE_CANCEL_PENDING" || booking.started || booking.status !== "UNDER_REVIEW") {
      throw httpError("The booking is no longer eligible for immediate pre-start cancellation", 409, "IMMEDIATE_CANCELLATION_STALE");
    }
  }

  const hasHeldOnlinePayment = ["PAID_HELD", "FROZEN_HELD"].includes(booking.paymentStatus);
  if (hasHeldOnlinePayment) await refundBookingPayment(booking.id, actorId || booking.seekerId, "Full refund for cancelled booking");

  let waitlistNotification: WaitlistNotification | null = null;
  await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, bookingId);
    const current = await tx.booking.findUnique({ where: { id: bookingId }, include: { queue: true, completedService: true, offer: { select: { requestId: true } } } });
    if (!current || current.status === "CANCELED") return;
    if (current.completedService || ["COMPLETED", "DECLINED", "REMOVED"].includes(current.status)) throw httpError("This booking can no longer be cancelled", 409);
    if (preStartRequestId && (current.started || current.status !== "UNDER_REVIEW")) throw httpError("The booking is no longer eligible for immediate pre-start cancellation", 409, "IMMEDIATE_CANCELLATION_STALE");

    if (!hasHeldOnlinePayment) {
      await assertNoRefundInProgress(tx, bookingId);
      if (current.queue) await lockServiceQueue(tx, current.queue.serviceId);
      await tx.booking.update({ where: { id: bookingId }, data: { status: "CANCELED", paymentStatus: current.paymentStatus, statusBeforeDispute: null } });
      if (current.queue) {
        await tx.queue.update({ where: { id: current.queue.id }, data: { status: "CANCELLED", paymentStatus: current.queue.paymentStatus } });
        await recalculateQueueInTransaction(tx, current.queue.serviceId);
        waitlistNotification = await notifyWaitlistInTransaction(tx, current.queue.serviceId);
      }
    }
    if (current.directRequestId) await tx.directRequest.updateMany({ where: { id: current.directRequestId }, data: { status: "DECLINED" } });
    if (current.offer?.requestId) await tx.serviceRequest.updateMany({ where: { id: current.offer.requestId }, data: { status: "CANCELED" } });
  });
  emitWaitlistNotification(waitlistNotification);

  await sendMessage(bookingId, booking.seekerId, "Booking cancelled.", undefined, true);
  await prisma.notification.create({ data: { userId: booking.providerId, title: "Booking cancelled", body: "The booking has been cancelled.", link: `/provider/provider-activity?tab=canceled&booking=${booking.id}` } });
  safeEmit(`user:${booking.providerId}`, "notification", { title: "Booking cancelled" });
  if (hasHeldOnlinePayment) {
    await prisma.notification.create({ data: { userId: booking.seekerId, title: "Refund processed", body: "Your online payment was refunded because the booking was cancelled.", link: `/seeker/seeker-activity?tab=canceled&booking=${booking.id}` } });
    safeEmit(`user:${booking.seekerId}`, "notification", { title: "Refund processed" });
  }
  for (const userId of [booking.providerId, booking.seekerId]) safeEmit(`user:${userId}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "cancelled" });
  safeEmit(`booking:${booking.id}`, "ENGAGEMENT_CHANGED", { bookingId: booking.id, type: "cancelled" });
}

export async function requestCancellation(bookingId: string, userId: string, reason: string) {
  const claim = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, bookingId);
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking || ![booking.seekerId, booking.providerId].includes(userId)) throw httpError("Booking not found or access denied", 404);
    const active = await tx.cancellationRequest.findFirst({ where: { bookingId, status: { in: ACTIVE_CANCELLATION_STATUSES } }, orderBy: { createdAt: "desc" } });
    if (active) {
      if (active.requestedBy === userId && active.status === "UNDER_REVIEW" && active.resolutionOutcome === "IMMEDIATE_CANCEL_PENDING" && (!booking.started || booking.status === "CANCELED")) return { booking, request: active, immediate: true, alreadyCancelled: false };
      if (active.requestedBy === userId) return { booking, request: active, immediate: false, alreadyCancelled: false };
      throw httpError("A cancellation request is already active for this booking", 409, "ACTIVE_CANCELLATION_EXISTS");
    }
    if (booking.status === "CANCELED") return { booking, request: null, immediate: true, alreadyCancelled: true };
    if (["COMPLETED", "DECLINED", "REMOVED", "DISPUTED", "UNDER_REVIEW"].includes(booking.status)) throw httpError("This booking can no longer be cancelled", 409);

    await assertNoFinancialResolutionReserved(tx, bookingId);

    const responderId = userId === booking.seekerId ? booking.providerId : booking.seekerId;
    const immediate = !booking.started;
    const request = await tx.cancellationRequest.create({ data: { bookingId, requestedBy: userId, responderId, reason: reason.trim(), status: immediate ? "UNDER_REVIEW" : "PENDING", resolutionOutcome: immediate ? "IMMEDIATE_CANCEL_PENDING" : null } });
    if (immediate) {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: "UNDER_REVIEW",
          statusBeforeDispute: booking.status,
          paymentStatus: booking.paymentStatus === "PAID_HELD" ? "FROZEN_HELD" : booking.paymentStatus,
        },
      });
      if (booking.paymentStatus === "PAID_HELD") await tx.queue.updateMany({ where: { bookingId }, data: { paymentStatus: "FROZEN_HELD" } });
    }
    return { booking, request, immediate, alreadyCancelled: false };
  });

  if (claim.alreadyCancelled) return { cancelled: true, immediate: true, alreadyCancelled: true };
  if (!claim.request) return { cancelled: true, immediate: true };

  if (claim.immediate) {
    try {
      await performImmediateCancel(bookingId, userId, claim.request.id);
      const request = await prisma.$transaction(async (tx) => {
        await lockBookingLifecycle(tx, bookingId);
        const booking = await tx.booking.findUnique({ where: { id: bookingId } });
        if (!booking || booking.status !== "CANCELED") throw httpError("Cancellation settlement has not completed", 409);
        return tx.cancellationRequest.update({ where: { id: claim.request!.id }, data: { status: "APPROVED", resolutionOutcome: "IMMEDIATE_CANCEL", resolvedAt: new Date() } });
      });
      return { cancelled: true, immediate: true, request };
    } catch (cause) {
      throw cause;
    }
  }

  const requesterRole = userId === claim.booking.seekerId ? "seeker" : "provider";
  await prisma.notification.create({ data: { userId: claim.request.responderId!, title: "Cancellation request received", body: `The ${requesterRole} requested to cancel this active booking. Review and respond.`, link: requesterRole === "seeker" ? `/provider/provider-activity?tab=in_progress&booking=${bookingId}` : `/seeker/seeker-activity?tab=active&booking=${bookingId}` } });
  safeEmit(`user:${claim.request.responderId}`, "notification", { title: "Cancellation request received" });
  return { cancelled: false, immediate: false, request: claim.request };
}

export async function respondToCancellationRequest(requestId: string, responderId: string, approve: boolean, responderNote?: string) {
  if (!approve) {
    const result = await prisma.$transaction(async (tx) => {
      const initial = await tx.cancellationRequest.findUnique({ where: { id: requestId } });
      if (!initial) throw httpError("Cancellation request not found or access denied", 404);
      await lockBookingLifecycle(tx, initial.bookingId);
      const request = await tx.cancellationRequest.findUnique({ where: { id: requestId }, include: { booking: true } });
      if (!request || request.responderId !== responderId || request.requestedBy === responderId) throw httpError("Cancellation request not found or access denied", 404);
      const changed = await tx.cancellationRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "DECLINED", responderNote, providerNote: responderNote, resolvedAt: new Date() } });
      if (changed.count !== 1) throw httpError("Cancellation request has already been decided", 409);
      await tx.notification.create({ data: { userId: request.requestedBy, title: "Cancellation request declined", body: `The other participant declined the request. ${responderNote || "No reason was supplied."}`, link: request.requestedBy === request.booking.seekerId ? `/seeker/seeker-activity?tab=active&booking=${request.bookingId}` : `/provider/provider-activity?tab=in_progress&booking=${request.bookingId}` } });
      return request;
    });
    safeEmit(`user:${result.requestedBy}`, "notification", { title: "Cancellation request declined" });
    return { resolved: true, approved: false };
  }

  const claim = await prisma.$transaction(async (tx) => {
    const initial = await tx.cancellationRequest.findUnique({ where: { id: requestId } });
    if (!initial) throw httpError("Cancellation request not found or access denied", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const request = await tx.cancellationRequest.findUnique({ where: { id: requestId }, include: { booking: true } });
    if (!request || request.responderId !== responderId || request.requestedBy === responderId) throw httpError("Cancellation request not found or access denied", 404);
    const existingOperation = await tx.adminResolutionOperation.findUnique({ where: { caseType_caseId: { caseType: "CANCELLATION", caseId: request.id } } });
    if (!["PENDING", "UNDER_REVIEW"].includes(request.status)) {
      if (existingOperation?.status === "COMPLETED") return { request, operation: existingOperation, completed: existingOperation.result };
      throw httpError("Cancellation request has already been decided", 409);
    }
    const operation = await beginAdminResolution(tx, { caseType: "CANCELLATION", caseId: request.id, bookingId: request.bookingId, adminId: responderId, outcome: "PARTICIPANT_APPROVE", notes: responderNote || "Approved by the opposite participant" });
    const completed = completedResolutionResult(operation);
    if (completed) return { request, operation, completed };
    await tx.cancellationRequest.update({ where: { id: request.id }, data: { status: "UNDER_REVIEW", responderNote, providerNote: responderNote } });
    return { request, operation, completed: null };
  });
  if (claim.completed) return claim.completed;

  try {
    if (!hasEstablishedFinancialEffect(claim.operation)) {
      await reserveCancellationFinancialOutcome(claim.operation.id, requestId);
      await performImmediateCancel(claim.request.bookingId, responderId);
      await markAdminResolutionStage(claim.operation.id, "FINANCIAL_EFFECT_ESTABLISHED");
    }
    const response = await prisma.$transaction(async (tx) => {
      await lockBookingLifecycle(tx, claim.request.bookingId);
      const operation = await tx.adminResolutionOperation.findUnique({ where: { id: claim.operation.id } });
      if (operation?.status === "COMPLETED") return operation.result;
      const booking = await tx.booking.findUnique({ where: { id: claim.request.bookingId } });
      if (!booking || booking.status !== "CANCELED" || (booking.paymentMethod !== "On-site Cash" && booking.paymentStatus !== "REFUNDED")) throw httpError("Cancellation/refund has not reached its valid final state", 409);
      await tx.cancellationRequest.update({ where: { id: requestId }, data: { status: "APPROVED", resolutionOutcome: "PARTICIPANT_APPROVED", resolvedAt: new Date() } });
      await tx.notification.create({ data: { userId: claim.request.requestedBy, title: "Cancellation request approved", body: "The other participant approved your cancellation request. Any eligible online refund was submitted.", link: claim.request.requestedBy === claim.request.booking.seekerId ? `/seeker/seeker-activity?tab=canceled&booking=${booking.id}` : `/provider/provider-activity?tab=canceled&booking=${booking.id}` } });
      const result = { resolved: true, approved: true, operationId: claim.operation.id };
      await tx.adminResolutionOperation.update({ where: { id: claim.operation.id }, data: { status: "COMPLETED", stage: "CASE_FINALIZED", result, completedAt: new Date() } });
      return result;
    });
    safeEmit(`user:${claim.request.requestedBy}`, "notification", { title: "Cancellation request approved" });
    return response;
  } catch (cause) {
    await markAdminResolutionFailed(claim.operation.id, cause);
    throw cause;
  }
}

export async function escalateCancellationRequest(requestId: string, userId: string) {
  const result = await prisma.$transaction(async (tx) => {
    const initial = await tx.cancellationRequest.findUnique({ where: { id: requestId } });
    if (!initial) throw httpError("Cancellation request not found or access denied", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const request = await tx.cancellationRequest.findUnique({ where: { id: requestId }, include: { booking: true, report: true } });
    if (!request || request.requestedBy !== userId) throw httpError("Cancellation request not found or access denied", 404);
    if (request.status === "ESCALATED" && request.report) return { request, report: request.report, created: false };
    if (request.status !== "DECLINED") throw httpError("Only a declined cancellation request can be escalated", 409);
    await assertNoFinancialResolutionReserved(tx, request.bookingId);
    const otherPartyId = userId === request.booking.seekerId ? request.booking.providerId : request.booking.seekerId;
    const requesterRole = userId === request.booking.seekerId ? "seeker" : "provider";
    const report = await tx.report.create({ data: { bookingId: request.bookingId, reporterId: userId, reportedUserId: otherPartyId, reason: "INCOMPLETE_SERVICE", description: `Cancellation escalation. ${requesterRole} reason: ${request.reason || "Not supplied"}. Response: ${request.responderNote || "Not supplied"}.`, reportType: "CANCELLATION_ESCALATION", status: "PENDING", dedupeKey: `cancellation:${request.id}` } });
    const updated = await tx.cancellationRequest.update({ where: { id: request.id }, data: { status: "ESCALATED", reportId: report.id } });
    await tx.notification.create({ data: { userId: otherPartyId, title: "Cancellation escalated to Admin", body: `The ${requesterRole} escalated the declined request for administrator review.`, link: userId === request.booking.seekerId ? `/provider/provider-activity?tab=disputed&booking=${request.bookingId}` : `/seeker/seeker-activity?tab=disputed&booking=${request.bookingId}` } });
    return { request: updated, report, created: true };
  });
  safeEmit(`user:${result.report.reportedUserId}`, "notification", { title: "Cancellation escalated to Admin" });
  return result.request;
}

export async function adminResolveCancellationRequest(requestId: string, approve: boolean, adminNote = "", adminId?: string) {
  if (!adminId) throw httpError("Administrator identity is required", 401);
  const outcome = approve ? "ADMIN_APPROVE" : "ADMIN_DENY";
  const claim = await prisma.$transaction(async (tx) => {
    const initial = await tx.cancellationRequest.findUnique({ where: { id: requestId } });
    if (!initial) throw httpError("Cancellation request not found", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const request = await tx.cancellationRequest.findUnique({ where: { id: requestId }, include: { booking: true, report: true } });
    if (!request) throw httpError("Cancellation request not found", 404);
    const existingOperation = await tx.adminResolutionOperation.findUnique({ where: { caseType_caseId: { caseType: "CANCELLATION", caseId: request.id } } });
    if (!["ESCALATED", "UNDER_REVIEW"].includes(request.status)) {
      if (existingOperation?.status === "COMPLETED") return { request, operation: existingOperation, completed: existingOperation.result };
      throw httpError("Only an escalated cancellation request can be resolved by Admin", 409);
    }
    const operation = await beginAdminResolution(tx, { caseType: "CANCELLATION", caseId: request.id, bookingId: request.bookingId, adminId, outcome, notes: adminNote });
    const completed = completedResolutionResult(operation);
    if (completed) return { request, operation, completed };
    if (!request.reportId || !request.report) throw httpError("This legacy cancellation escalation has no exact report linkage and requires operator repair", 409, "CANCELLATION_REPORT_LINK_MISSING");
    if (approve && !hasEstablishedFinancialEffect(operation)) await assertNoOtherBlockingCases(tx, request.bookingId, { cancellationRequestId: request.id, reportId: request.reportId });
    await tx.cancellationRequest.update({ where: { id: request.id }, data: { status: "UNDER_REVIEW", adminId, adminNote } });
    await tx.report.updateMany({ where: { id: request.reportId, status: { in: ["PENDING", "UNDER_REVIEW"] } }, data: { status: "UNDER_REVIEW", adminId, adminNotes: adminNote } });
    return { request, operation, completed: null };
  });
  if (claim.completed) return claim.completed;

  try {
    if (approve && !hasEstablishedFinancialEffect(claim.operation)) {
      await reserveCancellationFinancialOutcome(claim.operation.id, requestId);
      await performImmediateCancel(claim.request.bookingId, adminId);
      await markAdminResolutionStage(claim.operation.id, "FINANCIAL_EFFECT_ESTABLISHED");
    } else {
      await markAdminResolutionStage(claim.operation.id, "DECISION_READY");
    }
    const response = await prisma.$transaction(async (tx) => {
      await lockBookingLifecycle(tx, claim.request.bookingId);
      const operation = await tx.adminResolutionOperation.findUnique({ where: { id: claim.operation.id } });
      if (operation?.status === "COMPLETED") return operation.result;
      const request = await tx.cancellationRequest.findUnique({ where: { id: requestId }, include: { booking: true } });
      if (!request || request.status !== "UNDER_REVIEW" || !request.reportId) throw httpError("Cancellation case changed before finalization", 409);
      if (approve && (request.booking.status !== "CANCELED" || (request.booking.paymentMethod !== "On-site Cash" && request.booking.paymentStatus !== "REFUNDED"))) throw httpError("Cancellation/refund has not reached its valid final state", 409);
      await tx.cancellationRequest.update({ where: { id: request.id }, data: { status: "RESOLVED", resolutionOutcome: approve ? "APPROVED" : "DENIED", adminId, adminNote, resolvedAt: new Date() } });
      await tx.report.update({ where: { id: request.reportId }, data: { status: approve ? "RESOLVED" : "DISMISSED", adminId, adminNotes: adminNote, resolvedAt: new Date() } });
      if (!approve) await restoreBookingIfNoBlockingCases(tx, request.bookingId);
      await tx.adminAuditLog.create({ data: { actorId: adminId, targetUserId: request.booking.providerId, action: approve ? "CANCELLATION_APPROVED" : "CANCELLATION_DENIED", resourceType: "CancellationRequest", resourceId: request.id, reason: adminNote || "Administrator resolved escalated cancellation", metadata: { bookingId: request.bookingId, reportId: request.reportId, operationId: operation?.id } } });
      await tx.notification.createMany({ data: [
        { userId: request.booking.seekerId, title: "Cancellation case resolved", body: approve ? "Admin approved the cancellation and any eligible refund was submitted." : "Admin denied the cancellation; the booking remains active.", link: `/seeker/seeker-activity?tab=all&booking=${request.bookingId}` },
        { userId: request.booking.providerId, title: "Cancellation case resolved", body: approve ? "Admin approved the cancellation." : "Admin denied the cancellation; the booking remains active.", link: `/provider/provider-activity?tab=all&booking=${request.bookingId}` },
      ] });
      const result = { resolved: true, approved: approve, operationId: claim.operation.id };
      await tx.adminResolutionOperation.update({ where: { id: claim.operation.id }, data: { status: "COMPLETED", stage: "CASE_FINALIZED", result, completedAt: new Date(), lastError: null } });
      return result;
    });
    for (const id of [claim.request.booking.seekerId, claim.request.booking.providerId]) safeEmit(`user:${id}`, "ENGAGEMENT_CHANGED", { bookingId: claim.request.bookingId, type: "cancellation_admin_resolved" });
    return response;
  } catch (cause) {
    await markAdminResolutionFailed(claim.operation.id, cause);
    throw cause;
  }
}
