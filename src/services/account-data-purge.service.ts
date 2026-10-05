import { Prisma } from "@prisma/client";

// Called only after identity, lifecycle locks, and current obligations have been
// checked. Explicit ordering covers restrictive FKs and legacy string references.
// Every scope is derived from this one account; other accounts are never deleted.
export async function purgeAccountData(tx: Prisma.TransactionClient, userId: string) {
  // An AI request started before deletion must not recreate a string-keyed
  // summary afterward. No external request runs while this lock is held.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ai-review-summary-commit'))`;
  const participant = { OR: [{ seekerId: userId }, { providerId: userId }] };
  const services = await tx.service.findMany({ where: { providerId: userId }, select: { id: true } });
  const serviceIds = services.map(item => item.id);
  const requests = await tx.serviceRequest.findMany({ where: { OR: [{ seekerId: userId }, { targetProviderId: userId }, { targetServiceId: { in: serviceIds } }] }, select: { id: true } });
  const requestIds = requests.map(item => item.id);
  const offers = await tx.offer.findMany({ where: { OR: [{ providerId: userId }, { requestId: { in: requestIds } }, { serviceId: { in: serviceIds } }] }, select: { id: true } });
  const offerIds = offers.map(item => item.id);
  const direct = await tx.directRequest.findMany({ where: { OR: [...participant.OR, { serviceId: { in: serviceIds } }] }, select: { id: true } });
  const directIds = direct.map(item => item.id);
  const bookings = await tx.booking.findMany({ where: { OR: [...participant.OR, { serviceId: { in: serviceIds } }, { offerId: { in: offerIds } }, { directRequestId: { in: directIds } }] }, select: { id: true } });
  const bookingIds = bookings.map(item => item.id);
  const queueScope = { OR: [...participant.OR, { bookingId: { in: bookingIds } }, { serviceId: { in: serviceIds } }, { offerId: { in: offerIds } }] };
  const completed = await tx.completedService.findMany({ where: { OR: [...participant.OR, { bookingId: { in: bookingIds } }, { offerId: { in: offerIds } }, { directRequestId: { in: directIds } }, { queue: queueScope }] }, select: { id: true } });
  const completedIds = completed.map(item => item.id);
  const reviews = await tx.review.findMany({ where: { OR: [{ authorId: userId }, { targetId: userId }, { completedServiceId: { in: completedIds } }] }, select: { id: true, targetId: true } });
  const reviewIds = reviews.map(item => item.id);
  const attempts = await tx.paymentAttempt.findMany({ where: { OR: [...participant.OR, { serviceId: { in: serviceIds } }, { offerId: { in: offerIds } }] }, select: { id: true } });
  const attemptIds = attempts.map(item => item.id);
  const reports = await tx.report.findMany({ where: { OR: [{ reporterId: userId }, { reportedUserId: userId }, { bookingId: { in: bookingIds } }] }, select: { id: true } });
  const reportIds = reports.map(item => item.id);
  const verifications = await tx.serviceVerification.findMany({ where: { userId }, select: { id: true, proofs: { select: { id: true } } } });
  const contentScope = { OR: [{ submitterId: userId }, { contentOwnerId: userId }, { adminId: userId }, { resourceId: { in: [...serviceIds, ...requestIds] } }] };
  const cases = await tx.contentModerationCase.findMany({ where: contentScope, select: { id: true } });
  const relatedIds = [...new Set([userId, ...serviceIds, ...requestIds, ...offerIds, ...directIds, ...bookingIds, ...completedIds, ...reviewIds, ...attemptIds, ...reportIds, ...cases.map(item => item.id), ...verifications.flatMap(item => [item.id, ...item.proofs.map(proof => proof.id)])])];
  const extraResources = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM queue WHERE "seekerId" = ${userId} OR "providerId" = ${userId} OR "bookingId" IN (${Prisma.join(relatedIds)})
    UNION SELECT id FROM cancellation_requests WHERE "requestedBy" = ${userId} OR "responderId" = ${userId} OR "bookingId" IN (${Prisma.join(relatedIds)}) OR "reportId" IN (${Prisma.join(relatedIds)})
    UNION SELECT id FROM completion_escalations WHERE "requestedBy" = ${userId} OR "bookingId" IN (${Prisma.join(relatedIds)})
    UNION SELECT id FROM payment_refunds WHERE "requestedById" = ${userId} OR "bookingId" IN (${Prisma.join(relatedIds)}) OR "paymentAttemptId" IN (${Prisma.join(relatedIds)})
    UNION SELECT id FROM messages WHERE "senderId" = ${userId} OR "receiverId" = ${userId} OR "bookingId" IN (${Prisma.join(relatedIds)})
    UNION SELECT id FROM categories_suggested WHERE "submitterId" = ${userId}
    UNION SELECT id FROM ban_appeals WHERE "userId" = ${userId}
    UNION SELECT id FROM announcements WHERE "authorId" = ${userId}`);
  relatedIds.push(...extraResources.map(item => item.id));

  await tx.adminResolutionOperation.deleteMany({ where: { OR: [{ requestedByAdminId: userId }, { bookingId: { in: bookingIds } }, { caseId: { in: relatedIds } }] } });
  await tx.paymentRefund.deleteMany({ where: { OR: [{ requestedById: userId }, { bookingId: { in: bookingIds } }, { paymentAttemptId: { in: attemptIds } }] } });
  await tx.review.deleteMany({ where: { id: { in: reviewIds } } });
  await tx.completedService.deleteMany({ where: { id: { in: completedIds } } });
  await tx.queue.deleteMany({ where: queueScope });
  await tx.message.deleteMany({ where: { OR: [{ senderId: userId }, { receiverId: userId }, { bookingId: { in: bookingIds } }] } });
  await tx.cancellationRequest.deleteMany({ where: { OR: [{ requestedBy: userId }, { responderId: userId }, { adminId: userId }, { bookingId: { in: bookingIds } }, { reportId: { in: reportIds } }] } });
  await tx.completionEscalation.deleteMany({ where: { OR: [{ requestedBy: userId }, { adminId: userId }, { bookingId: { in: bookingIds } }] } });
  await tx.report.deleteMany({ where: { id: { in: reportIds } } });
  await tx.booking.deleteMany({ where: { id: { in: bookingIds } } });
  await tx.directRequest.deleteMany({ where: { id: { in: directIds } } });
  await tx.offer.deleteMany({ where: { id: { in: offerIds } } });
  await tx.paymentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
  await tx.contentModerationCase.deleteMany({ where: contentScope });
  await tx.contentModerationEvent.deleteMany({ where: { OR: [{ actorId: userId }, { resourceId: { in: relatedIds } }] } });
  await tx.serviceRequest.deleteMany({ where: { id: { in: requestIds } } });
  await tx.service.deleteMany({ where: { id: { in: serviceIds } } });
  await tx.banAppeal.deleteMany({ where: { userId } });
  await tx.accountDeletionRequest.deleteMany({ where: { userId } });
  // String links and cached summaries have no foreign key cascade.
  await tx.$executeRaw(Prisma.sql`DELETE FROM notifications WHERE "userId" = ${userId}
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[${Prisma.join(relatedIds)}]::text[]) AS resource(id) WHERE strpos(COALESCE(link, ''), resource.id) > 0)`);
  await tx.$executeRaw(Prisma.sql`DELETE FROM transactions WHERE "walletOwnerId" = ${userId}
    OR "relatedBookingId" IN (${Prisma.join([...bookingIds, ...completedIds, userId])})`);
  await tx.$executeRaw(Prisma.sql`DELETE FROM trust_score_events WHERE "userId" = ${userId} OR "actorAdminId" = ${userId}
    OR EXISTS (SELECT 1 FROM unnest(ARRAY[${Prisma.join(relatedIds)}]::text[]) AS resource(id) WHERE strpos(COALESCE("eventKey", ''), resource.id) > 0)`);
  await tx.$executeRaw(Prisma.sql`DELETE FROM admin_audit_logs WHERE "actorId" = ${userId} OR "targetUserId" = ${userId}
    OR "resourceId" IN (${Prisma.join(relatedIds)}) OR strpos(COALESCE(metadata::text, ''), ${userId}) > 0`);
  await tx.aiReviewSummary.deleteMany({ where: { providerId: { in: [...new Set([userId, ...reviews.map(item => item.targetId)])] } } });
  // Auth, verification/proof, suggestions, remaining personal notifications,
  // queue notifications, and personal trust rows cascade from the real DELETE.
  await tx.user.delete({ where: { id: userId } });
  return { removedBookings: bookingIds.length, removedReviews: reviewIds.length };
}
