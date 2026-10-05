import { prisma } from "../lib/prisma";
import { safeBroadcast, safeEmit } from "../lib/socket";
import { lockBookingLifecycle } from "./booking-lifecycle.service";
import { assertNoFinancialResolutionReserved, assertNoOtherBlockingCases } from "./case-resolution.service";
import { performImmediateCancel } from "./cancellation.service";
import { settleCompletedBooking } from "./bookings/completion.service";
import {
  beginAdminResolution,
  completedResolutionResult,
  hasEstablishedFinancialEffect,
  markAdminResolutionFailed,
  markAdminResolutionStage,
  markAdminResolutionStageInTransaction,
  reconcileReservedFinancialEffect,
} from "./admin-resolution-operation.service";

export type AdminBookingOutcome = "cancel_booking" | "release_provider_and_complete";

export function adminBookingOutcomeAllowed(
  booking: { status: string; started: boolean; paymentMethod: string },
  hasBannedParticipant: boolean,
  outcome: AdminBookingOutcome,
) {
  if (outcome === "release_provider_and_complete") {
    return hasBannedParticipant && booking.status === "AWAITING_CONFIRMATION" && booking.paymentMethod !== "On-site Cash";
  }
  return (!booking.started && ["PENDING_APPROVAL", "WAITING", "ACCEPTED"].includes(booking.status))
    || (hasBannedParticipant && ["ONGOING", "AWAITING_CONFIRMATION"].includes(booking.status));
}

function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409, code: "ADMIN_BOOKING_RESOLUTION_CONFLICT" });
}

/** A single durable decision per booking. The booking is held in UNDER_REVIEW
 * before crossing the PayMongo boundary, so participant actions cannot race
 * the administrator's refund or settlement. */
export async function resolveAdminBooking(input: {
  bookingId: string;
  adminId: string;
  outcome: AdminBookingOutcome;
  reason: string;
  requireBannedParticipant: boolean;
}) {
  const claimed = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, input.bookingId);
    const booking = await tx.booking.findUnique({
      where: { id: input.bookingId },
      include: { seeker: { select: { moderationStatus: true } }, provider: { select: { moderationStatus: true } } },
    });
    if (!booking) throw Object.assign(new Error("Booking not found"), { status: 404 });
    const existing = await tx.adminResolutionOperation.findUnique({
      where: { caseType_caseId: { caseType: "ADMIN_BOOKING", caseId: booking.id } },
    });
    if (existing?.status === "COMPLETED") {
      if (existing.requestedOutcome !== input.outcome) throw conflict("This booking already has a different administrator decision");
      return { operation: existing, completed: existing.result };
    }
    if (existing?.status === "FAILED_NONRETRYABLE" || existing?.stage === "CASE_FINALIZED") {
      throw conflict("This booking decision can no longer be retried");
    }

    const hasBannedParticipant = booking.seeker.moderationStatus === "BANNED" || booking.provider.moderationStatus === "BANNED";
    if (input.requireBannedParticipant && !hasBannedParticipant && !existing) throw conflict("This resolution is only available for a booking with a banned participant");
    if (!existing && !adminBookingOutcomeAllowed(booking, hasBannedParticipant, input.outcome)) {
      throw conflict("This booking state is not eligible for that administrator decision");
    }

    let operation = await beginAdminResolution(tx, {
      caseType: "ADMIN_BOOKING", caseId: booking.id, bookingId: booking.id,
      adminId: input.adminId, outcome: input.outcome, notes: input.reason,
    });
    operation = await reconcileReservedFinancialEffect(tx, operation, input.outcome);
    const completed = completedResolutionResult(operation);
    if (completed) return { operation, completed };
    if (!hasEstablishedFinancialEffect(operation)) {
      if (operation.stage === "FINANCIAL_EFFECT_RESERVED") {
        if (booking.status !== "UNDER_REVIEW" || !booking.statusBeforeDispute) throw conflict("Booking changed during administrator resolution");
      } else {
        if (!adminBookingOutcomeAllowed(booking, hasBannedParticipant, input.outcome)) throw conflict("Booking changed before the administrator decision was reserved");
        await assertNoOtherBlockingCases(tx, booking.id);
        await assertNoFinancialResolutionReserved(tx, booking.id, operation.id);
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: "UNDER_REVIEW", statusBeforeDispute: booking.status },
        });
        operation = await markAdminResolutionStageInTransaction(tx, operation.id, "FINANCIAL_EFFECT_RESERVED");
      }
    }
    return { operation, completed: null };
  });
  if (claimed.completed) return claimed.completed;

  try {
    if (!hasEstablishedFinancialEffect(claimed.operation)) {
      if (input.outcome === "cancel_booking") await performImmediateCancel(input.bookingId, input.adminId);
      else await settleCompletedBooking(input.bookingId, { type: "ADMIN", userId: input.adminId });
      await markAdminResolutionStage(claimed.operation.id, "FINANCIAL_EFFECT_ESTABLISHED");
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockBookingLifecycle(tx, input.bookingId);
      const operation = await tx.adminResolutionOperation.findUniqueOrThrow({ where: { id: claimed.operation.id } });
      if (operation.status === "COMPLETED") return operation.result;
      const booking = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId } });
      const cancelled = booking.status === "CANCELED"
        && (booking.paymentMethod === "On-site Cash" ? booking.paymentStatus === "UNPAID" : booking.paymentStatus === "REFUNDED");
      const completed = booking.status === "COMPLETED" && booking.paymentStatus === "RELEASED";
      if (input.outcome === "cancel_booking" ? !cancelled : !completed) throw conflict("The financial outcome has not reached its expected final state");
      await tx.adminAuditLog.create({ data: {
        actorId: input.adminId,
        targetUserId: booking.providerId,
        action: input.outcome === "cancel_booking" ? "ADMIN_BOOKING_CANCELLED" : "ADMIN_BOOKING_COMPLETED",
        resourceType: "Booking",
        resourceId: booking.id,
        reason: operation.notes,
        metadata: { operationId: operation.id, seekerId: booking.seekerId, providerId: booking.providerId },
      } });
      const title = input.outcome === "cancel_booking" ? "Booking cancelled by Admin" : "Booking completed by Admin";
      const body = input.outcome === "cancel_booking"
        ? "An administrator cancelled this booking and processed any held online payment for refund."
        : "An administrator confirmed completion and released the held online payment.";
      await tx.notification.createMany({ data: [
        { userId: booking.seekerId, title, body, link: `/seeker/seeker-activity?tab=all&booking=${booking.id}` },
        { userId: booking.providerId, title, body, link: `/provider/provider-activity?tab=all&booking=${booking.id}` },
      ] });
      const response = { resolved: true, bookingId: booking.id, outcome: input.outcome, operationId: operation.id };
      await tx.adminResolutionOperation.update({ where: { id: operation.id }, data: {
        status: "COMPLETED", stage: "CASE_FINALIZED", result: response, completedAt: new Date(), lastError: null,
      } });
      return response;
    });
    try {
      const participants = await prisma.booking.findUnique({
        where: { id: input.bookingId },
        select: { seekerId: true, providerId: true },
      });
      if (participants) for (const userId of [participants.seekerId, participants.providerId]) {
        safeEmit(`user:${userId}`, "notification", { title: "Booking resolution completed" });
        safeEmit(`user:${userId}`, "ENGAGEMENT_CHANGED", { bookingId: input.bookingId, type: "admin_resolved" });
      }
      safeBroadcast("ADMIN_MODERATION_CHANGED", { type: "booking_resolved", bookingId: input.bookingId });
    } catch (error) {
      console.error("Post-resolution realtime notification failed", error);
    }
    return result;
  } catch (cause) {
    await markAdminResolutionFailed(claimed.operation.id, cause);
    throw cause;
  }
}
