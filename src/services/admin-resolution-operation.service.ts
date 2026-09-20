import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export type ResolutionCaseType = "REPORT" | "COMPLETION_ESCALATION" | "CANCELLATION";

export const ADMIN_RESOLUTION_STAGE_ORDER = {
  CLAIMED: 0,
  DECISION_READY: 1,
  FINANCIAL_EFFECT_RESERVED: 2,
  FINANCIAL_EFFECT_ESTABLISHED: 3,
  CASE_FINALIZED: 4,
} as const;

export type AdminResolutionStage = keyof typeof ADMIN_RESOLUTION_STAGE_ORDER;

function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409, code: "RESOLUTION_OPERATION_CONFLICT" });
}

export async function beginAdminResolution(
  tx: Prisma.TransactionClient,
  input: {
    caseType: ResolutionCaseType;
    caseId: string;
    bookingId: string;
    adminId: string;
    outcome: string;
    penalty?: string;
    notes: string;
  },
) {
  const existing = await tx.adminResolutionOperation.findUnique({
    where: { caseType_caseId: { caseType: input.caseType, caseId: input.caseId } },
  });
  if (existing) {
    if (existing.requestedOutcome !== input.outcome || (existing.requestedPenalty || "none") !== (input.penalty || "none")) {
      throw conflict("This case already has a different administrator decision in progress");
    }
    if (existing.status === "COMPLETED" || existing.status === "FAILED_NONRETRYABLE" || existing.stage === "CASE_FINALIZED") return existing;
    await tx.adminResolutionOperation.updateMany({
      where: { id: existing.id, status: { in: ["PROCESSING", "FAILED_RETRYABLE"] }, stage: existing.stage },
      data: { status: "PROCESSING", lastError: null },
    });
    return tx.adminResolutionOperation.findUniqueOrThrow({ where: { id: existing.id } });
  }
  return tx.adminResolutionOperation.create({
    data: {
      operationKey: `${input.caseType}:${input.caseId}`,
      caseType: input.caseType,
      caseId: input.caseId,
      bookingId: input.bookingId,
      requestedByAdminId: input.adminId,
      requestedOutcome: input.outcome,
      requestedPenalty: input.penalty || null,
      notes: input.notes,
    },
  });
}

export function hasEstablishedFinancialEffect(operation: { stage: string }) {
  return operation.stage === "FINANCIAL_EFFECT_ESTABLISHED" || operation.stage === "CASE_FINALIZED";
}

export async function markAdminResolutionStageInTransaction(
  tx: Prisma.TransactionClient,
  operationId: string,
  stage: AdminResolutionStage,
) {
  const current = await tx.adminResolutionOperation.findUnique({ where: { id: operationId } });
  if (!current) throw conflict("Resolution operation not found");
  if (current.status === "COMPLETED" || current.status === "FAILED_NONRETRYABLE" || current.stage === "CASE_FINALIZED") return current;

  const currentRank = ADMIN_RESOLUTION_STAGE_ORDER[current.stage as AdminResolutionStage];
  const requestedRank = ADMIN_RESOLUTION_STAGE_ORDER[stage];
  if (currentRank === undefined) throw conflict(`Unknown persisted resolution stage: ${current.stage}`);
  if (requestedRank < currentRank) return current;

  await tx.adminResolutionOperation.updateMany({
    where: {
      id: operationId,
      stage: current.stage,
      status: { in: ["PROCESSING", "FAILED_RETRYABLE"] },
    },
    data: { stage, status: "PROCESSING", lastError: null },
  });
  return tx.adminResolutionOperation.findUniqueOrThrow({ where: { id: operationId } });
}

export async function markAdminResolutionStage(operationId: string, stage: AdminResolutionStage) {
  return prisma.$transaction((tx) => markAdminResolutionStageInTransaction(tx, operationId, stage));
}

export async function markAdminResolutionFailed(operationId: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message : "Unknown resolution failure";
  await prisma.adminResolutionOperation.updateMany({
    where: {
      id: operationId,
      status: { in: ["PROCESSING", "FAILED_RETRYABLE"] },
      stage: { not: "CASE_FINALIZED" },
    },
    data: { status: "FAILED_RETRYABLE", lastError: message.slice(0, 1000) },
  });
}

export function completedResolutionResult(operation: { status: string; result: unknown }) {
  return operation.status === "COMPLETED" ? operation.result : null;
}
