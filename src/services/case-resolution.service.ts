import type { Prisma } from "@prisma/client";

const ACTIVE_REPORT_STATUSES = ["PENDING", "UNDER_REVIEW"] as const;
const ACTIVE_CANCELLATION_STATUSES = ["PENDING", "DECLINED", "ESCALATED", "UNDER_REVIEW"] as const;
const ACTIVE_COMPLETION_ESCALATION_STATUSES = ["PENDING", "UNDER_REVIEW"] as const;
const FINANCIAL_RESERVATION_STAGES = ["FINANCIAL_EFFECT_RESERVED", "FINANCIAL_EFFECT_ESTABLISHED"] as const;

function conflict(message: string, code: string) {
  return Object.assign(new Error(message), { status: 409, code });
}

export interface CaseExclusions {
  reportId?: string;
  cancellationRequestId?: string;
  completionEscalationId?: string;
  operationId?: string;
}

export async function assertNoOtherBlockingCases(
  tx: Prisma.TransactionClient,
  bookingId: string,
  exclude: CaseExclusions = {},
) {
  const reports = await tx.report.count({
    where: {
      bookingId,
      status: { in: [...ACTIVE_REPORT_STATUSES] },
      ...(exclude.reportId ? { id: { not: exclude.reportId } } : {}),
    },
  });
  const cancellations = await tx.cancellationRequest.count({
    where: {
      bookingId,
      status: { in: [...ACTIVE_CANCELLATION_STATUSES] },
      ...(exclude.cancellationRequestId ? { id: { not: exclude.cancellationRequestId } } : {}),
    },
  });
  const escalations = await tx.completionEscalation.count({
    where: {
      bookingId,
      status: { in: [...ACTIVE_COMPLETION_ESCALATION_STATUSES] },
      ...(exclude.completionEscalationId ? { id: { not: exclude.completionEscalationId } } : {}),
    },
  });
  if (reports + cancellations + escalations > 0) {
    throw conflict("Resolve the other active booking case before applying a financial outcome", "OTHER_BLOCKING_CASES");
  }
}

export async function assertNoFinancialResolutionReserved(
  tx: Prisma.TransactionClient,
  bookingId: string,
  operationId?: string,
) {
  const operation = await tx.adminResolutionOperation.findFirst({
    where: {
      bookingId,
      status: { in: ["PROCESSING", "FAILED_RETRYABLE"] },
      stage: { in: [...FINANCIAL_RESERVATION_STAGES] },
      ...(operationId ? { id: { not: operationId } } : {}),
    },
    select: { id: true },
  });
  if (operation) {
    throw conflict("A financial resolution is already reserved for this booking", "FINANCIAL_RESOLUTION_IN_PROGRESS");
  }
}

export async function restoreBookingIfNoBlockingCases(tx: Prisma.TransactionClient, bookingId: string) {
  const reportCount = await tx.report.count({ where: { bookingId, status: { in: [...ACTIVE_REPORT_STATUSES] } } });
  const cancellationCount = await tx.cancellationRequest.count({ where: { bookingId, status: { in: [...ACTIVE_CANCELLATION_STATUSES] } } });
  if (reportCount + cancellationCount > 0) return false;

  const booking = await tx.booking.findUnique({ where: { id: bookingId } });
  if (!booking || !["DISPUTED", "UNDER_REVIEW"].includes(booking.status) || !booking.statusBeforeDispute) return false;

  const paymentStatus = booking.paymentMethod === "On-site Cash" ? "UNPAID" : "PAID_HELD";
  const restored = await tx.booking.updateMany({
    where: { id: bookingId, status: booking.status, statusBeforeDispute: booking.statusBeforeDispute },
    data: { status: booking.statusBeforeDispute, statusBeforeDispute: null, paymentStatus },
  });
  if (restored.count === 1) {
    await tx.queue.updateMany({ where: { bookingId }, data: { paymentStatus } });
    return true;
  }
  return false;
}
