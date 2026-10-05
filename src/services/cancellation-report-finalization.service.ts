import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { lockBookingLifecycle } from './booking-lifecycle.service';
import { safeEmit } from '../lib/socket';

/** Close only the escalation linked to a successfully settled participant approval. */
export async function closeParticipantCancellationReport(
  tx: Prisma.TransactionClient,
  request: { id: string; bookingId: string; reportId: string | null; responderId: string | null },
  resolvedAt: Date,
) {
  if (!request.reportId) return false;
  const changed = await tx.report.updateMany({
    where: { id: request.reportId, bookingId: request.bookingId, reportType: 'CANCELLATION_ESCALATION', status: { in: ['PENDING', 'UNDER_REVIEW'] } },
    data: { status: 'RESOLVED', resolvedAt, adminNotes: 'Cancellation approved by the other participant. The booking is cancelled; no further cancellation decision is required.' },
  });
  if (changed.count && request.responderId) {
    await tx.adminAuditLog.create({ data: {
      actorId: request.responderId, action: 'CANCELLATION_CASE_CLOSED_BY_PARTICIPANT', resourceType: 'Report', resourceId: request.reportId,
      reason: 'The other participant approved cancellation and settlement completed.', metadata: { bookingId: request.bookingId, cancellationRequestId: request.id },
    } });
  }
  return changed.count > 0;
}

/** Repair old orphaned reports without cancelling a booking or repeating any refund. */
export async function repairCompletedParticipantCancellationReport(requestId: string) {
  const repaired = await prisma.$transaction(async tx => {
    const initial = await tx.cancellationRequest.findUnique({ where: { id: requestId } });
    if (!initial) throw new Error('Cancellation request not found');
    await lockBookingLifecycle(tx, initial.bookingId);
    const request = await tx.cancellationRequest.findUniqueOrThrow({ where: { id: requestId }, include: { booking: true } });
    const operation = await tx.adminResolutionOperation.findUnique({ where: { caseType_caseId: { caseType: 'CANCELLATION', caseId: request.id } } });
    if (request.status !== 'APPROVED' || request.resolutionOutcome !== 'PARTICIPANT_APPROVED'
      || !request.resolvedAt || request.booking.status !== 'CANCELED'
      || (request.booking.paymentMethod !== 'On-site Cash' && request.booking.paymentStatus !== 'REFUNDED')
      || operation?.status !== 'COMPLETED' || operation.stage !== 'CASE_FINALIZED' || operation.requestedOutcome !== 'PARTICIPANT_APPROVE') {
      throw new Error('This case has no verified completed participant cancellation to reconcile');
    }
    return closeParticipantCancellationReport(tx, request, request.resolvedAt);
  });
  if (repaired) safeEmit('admin', 'ADMIN_MODERATION_CHANGED', { cancellationRequestId: requestId });
  return repaired;
}
