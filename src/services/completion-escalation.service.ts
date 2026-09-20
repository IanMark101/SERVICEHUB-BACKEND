import { prisma } from "../lib/prisma";
import { safeBroadcast, safeEmit } from "../lib/socket";
import { settleCompletedBooking } from "./bookings/completion.service";
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
import { assertNoFinancialResolutionReserved, assertNoOtherBlockingCases } from "./case-resolution.service";

const WAIT_MS = 72 * 60 * 60 * 1000;
const RETRY_COOLDOWN_MS = WAIT_MS;

export type CompletionEscalationAction =
  | "release_provider_and_complete"
  | "refund_seeker"
  | "keep_awaiting";

function httpError(message: string, status: number, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  error.code = code;
  return error;
}

function resolutionCode(action: CompletionEscalationAction) {
  if (action === "release_provider_and_complete") return "RELEASE_PROVIDER_AND_COMPLETE";
  if (action === "refund_seeker") return "REFUND_SEEKER";
  return "KEEP_AWAITING";
}

export async function createCompletionEscalation(bookingId: string, providerId: string, reason: string) {
  const result = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, bookingId);
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.providerId !== providerId) throw httpError("Booking not found or access denied", 404);
    await assertNoFinancialResolutionReserved(tx, bookingId);
    if (booking.status !== "AWAITING_CONFIRMATION") throw httpError("Only a booking awaiting seeker confirmation can be escalated", 409);
    if (booking.updatedAt.getTime() + WAIT_MS > Date.now()) throw httpError("Completion can be escalated after 72 hours without a seeker response", 409, "ESCALATION_WAIT_PERIOD");

    const previous = await tx.completionEscalation.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } });
    if (previous && ["PENDING", "UNDER_REVIEW"].includes(previous.status)) return { escalation: previous, created: false, adminIds: [] as string[] };
    if (previous?.resolution === "KEEP_AWAITING" && previous.resolvedAt && previous.resolvedAt.getTime() + RETRY_COOLDOWN_MS > Date.now()) {
      throw httpError("Wait 72 hours before submitting another completion escalation", 409, "ESCALATION_COOLDOWN");
    }

    const escalation = await tx.completionEscalation.create({ data: { bookingId, requestedBy: providerId, reason: reason.trim() } });
    const admins = await tx.user.findMany({ where: { role: "admin", isActive: true, moderationStatus: "ACTIVE" }, select: { id: true } });
    if (admins.length) {
      await tx.notification.createMany({ data: admins.map((admin) => ({
        userId: admin.id,
        title: "Completion escalation requires review",
        body: "A provider requested administrator review after the 72-hour seeker response window.",
        link: `/admin/reports?booking=${bookingId}`,
      })) });
    }
    return { escalation, created: true, adminIds: admins.map((admin) => admin.id) };
  });

  if (result.created) {
    result.adminIds.forEach((adminId) => safeEmit(`user:${adminId}`, "notification", { title: "Completion escalation requires review" }));
    safeEmit("admin", "ADMIN_MODERATION_CHANGED", { type: "completion_escalation", bookingId });
  }
  return result.escalation;
}

export async function listCompletionEscalations(page = 1, limit = 20) {
  const where = { status: { in: ["PENDING", "UNDER_REVIEW"] } };
  const [items, total] = await Promise.all([
    prisma.completionEscalation.findMany({ where, include: { booking: { include: { seeker: { select: { id: true, name: true } }, provider: { select: { id: true, name: true } }, service: { select: { title: true } } } } }, orderBy: { createdAt: "asc" }, skip: (page - 1) * limit, take: limit }),
    prisma.completionEscalation.count({ where }),
  ]);
  const operations = await prisma.adminResolutionOperation.findMany({ where: { caseType: "COMPLETION_ESCALATION", caseId: { in: items.map((item) => item.id) } } });
  const byCase = new Map(operations.map((operation) => [operation.caseId, operation]));
  return { items: items.map((item) => ({ ...item, resolutionOperation: byCase.get(item.id) || null })), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function resolveCompletionEscalation(params: {
  escalationId: string;
  adminId: string;
  action: CompletionEscalationAction;
  resolution: string;
}) {
  const claimed = await prisma.$transaction(async (tx) => {
    const initial = await tx.completionEscalation.findUnique({ where: { id: params.escalationId } });
    if (!initial) throw httpError("Completion escalation not found", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const escalation = await tx.completionEscalation.findUnique({ where: { id: initial.id }, include: { booking: true } });
    if (!escalation) throw httpError("Completion escalation not found", 404);
    const existingOperation = await tx.adminResolutionOperation.findUnique({ where: { caseType_caseId: { caseType: "COMPLETION_ESCALATION", caseId: escalation.id } } });
    if (!["PENDING", "UNDER_REVIEW"].includes(escalation.status)) {
      if (existingOperation?.status === "COMPLETED") return { operation: existingOperation, completed: existingOperation.result };
      throw httpError("This escalation was superseded or already resolved", 409, "STALE_ESCALATION");
    }
    const operation = await beginAdminResolution(tx, {
      caseType: "COMPLETION_ESCALATION", caseId: escalation.id, bookingId: escalation.bookingId,
      adminId: params.adminId, outcome: params.action, notes: params.resolution,
    });
    const completed = completedResolutionResult(operation);
    if (completed) return { operation, completed };
    const effectEstablished = hasEstablishedFinancialEffect(operation);
    const reservedRetry = escalation.booking.status === "UNDER_REVIEW"
      && escalation.booking.statusBeforeDispute === "AWAITING_CONFIRMATION"
      && operation.stage === "FINANCIAL_EFFECT_RESERVED";
    if (!effectEstablished && escalation.booking.status !== "AWAITING_CONFIRMATION" && !reservedRetry) throw httpError("The booking changed before this escalation could be resolved", 409, "STALE_ESCALATION");
    await tx.completionEscalation.update({ where: { id: escalation.id }, data: { status: "UNDER_REVIEW", adminId: params.adminId, resolution: resolutionCode(params.action) } });
    return { operation, completed: null };
  });

  if (claimed.completed) return claimed.completed;
  try {
    const effectAlreadyEstablished = hasEstablishedFinancialEffect(claimed.operation);
    if (params.action === "release_provider_and_complete" && !effectAlreadyEstablished) {
      await reserveCompletionFinancialOutcome(claimed.operation.id, params.escalationId);
      await settleCompletedBooking(claimed.operation.bookingId, { type: "ADMIN", userId: params.adminId });
      await markAdminResolutionStage(claimed.operation.id, "FINANCIAL_EFFECT_ESTABLISHED");
    } else if (params.action === "refund_seeker" && !effectAlreadyEstablished) {
      await reserveCompletionFinancialOutcome(claimed.operation.id, params.escalationId);
      await performImmediateCancel(claimed.operation.bookingId, params.adminId);
      await markAdminResolutionStage(claimed.operation.id, "FINANCIAL_EFFECT_ESTABLISHED");
    } else {
      await markAdminResolutionStage(claimed.operation.id, "DECISION_READY");
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockBookingLifecycle(tx, claimed.operation.bookingId);
      const operation = await tx.adminResolutionOperation.findUnique({ where: { id: claimed.operation.id } });
      if (!operation) throw httpError("Resolution operation not found", 500);
      if (operation.status === "COMPLETED") return operation.result;
      const escalation = await tx.completionEscalation.findUnique({ where: { id: params.escalationId }, include: { booking: true } });
      if (!escalation || escalation.status !== "UNDER_REVIEW") throw httpError("This escalation was superseded before finalization", 409, "STALE_ESCALATION");
      if (params.action === "release_provider_and_complete" && (escalation.booking.status !== "COMPLETED" || !["RELEASED", "CASH_CONFIRMED"].includes(escalation.booking.paymentStatus))) throw httpError("Completion settlement has not reached its valid final state", 409);
      if (params.action === "refund_seeker" && (escalation.booking.status !== "CANCELED" || (escalation.booking.paymentMethod !== "On-site Cash" && escalation.booking.paymentStatus !== "REFUNDED"))) throw httpError("Cancellation/refund has not reached its valid final state", 409);
      if (params.action === "keep_awaiting" && escalation.booking.status !== "AWAITING_CONFIRMATION") throw httpError("The booking is no longer awaiting confirmation", 409, "STALE_ESCALATION");

      const code = resolutionCode(params.action);
      await tx.completionEscalation.update({ where: { id: escalation.id }, data: { status: "RESOLVED", adminId: params.adminId, resolution: code, resolvedAt: new Date() } });
      await tx.adminAuditLog.create({ data: { actorId: params.adminId, targetUserId: escalation.requestedBy, action: `COMPLETION_ESCALATION_${code}`, resourceType: "CompletionEscalation", resourceId: escalation.id, reason: params.resolution, metadata: { bookingId: escalation.bookingId, operationId: operation.id } } });
      await tx.notification.createMany({ data: [
        { userId: escalation.booking.providerId, title: "Completion escalation resolved", body: `Administrator decision: ${code.replace(/_/g, " ").toLowerCase()}.`, link: `/provider/provider-activity?tab=all&booking=${escalation.bookingId}` },
        { userId: escalation.booking.seekerId, title: "Completion escalation resolved", body: `Administrator decision: ${code.replace(/_/g, " ").toLowerCase()}.`, link: `/seeker/seeker-activity?tab=all&booking=${escalation.bookingId}` },
      ] });
      const response = { resolved: true, outcome: code, bookingId: escalation.bookingId, operationId: operation.id };
      await tx.adminResolutionOperation.update({ where: { id: operation.id }, data: { status: "COMPLETED", stage: "CASE_FINALIZED", result: response, completedAt: new Date(), lastError: null } });
      return response;
    });
    safeBroadcast("ADMIN_MODERATION_CHANGED", { type: "completion_escalation_resolved", bookingId: claimed.operation.bookingId });
    return result;
  } catch (cause) {
    await markAdminResolutionFailed(claimed.operation.id, cause);
    throw cause;
  }
}

async function reserveCompletionFinancialOutcome(operationId: string, escalationId: string) {
  return prisma.$transaction(async (tx) => {
    const initial = await tx.completionEscalation.findUnique({ where: { id: escalationId } });
    if (!initial) throw httpError("Completion escalation not found", 404);
    await lockBookingLifecycle(tx, initial.bookingId);
    const escalation = await tx.completionEscalation.findUnique({ where: { id: escalationId }, include: { booking: true } });
    const operation = await tx.adminResolutionOperation.findUnique({ where: { id: operationId } });
    if (!escalation || escalation.status !== "UNDER_REVIEW" || !operation || operation.status === "COMPLETED") {
      throw httpError("This escalation was superseded before settlement began", 409, "STALE_ESCALATION");
    }
    if (hasEstablishedFinancialEffect(operation)) return operation;
    await assertNoOtherBlockingCases(tx, escalation.bookingId, { completionEscalationId: escalation.id });
    const alreadyReserved = escalation.booking.status === "UNDER_REVIEW" && escalation.booking.statusBeforeDispute === "AWAITING_CONFIRMATION";
    if (!alreadyReserved && escalation.booking.status !== "AWAITING_CONFIRMATION") {
      throw httpError("The seeker resolved or disputed this booking before settlement began", 409, "STALE_ESCALATION");
    }
    if (!alreadyReserved) {
      const reserved = await tx.booking.updateMany({ where: { id: escalation.bookingId, status: "AWAITING_CONFIRMATION" }, data: { status: "UNDER_REVIEW", statusBeforeDispute: "AWAITING_CONFIRMATION" } });
      if (reserved.count !== 1) throw httpError("The seeker resolved or disputed this booking before settlement began", 409, "STALE_ESCALATION");
    }
    return markAdminResolutionStageInTransaction(tx, operationId, "FINANCIAL_EFFECT_RESERVED");
  });
}
