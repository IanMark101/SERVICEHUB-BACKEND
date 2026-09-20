import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { createSafetyReport } from "../services/safety-report.service";
import { recalculateQueue } from "../services/queue.service";
import { confirmCompletionService, disputeJobService } from "../services/bookings/completion.service";
import { createCompletionEscalation, resolveCompletionEscalation } from "../services/completion-escalation.service";
import { adminResolveCancellationRequest, escalateCancellationRequest, requestCancellation, respondToCancellationRequest } from "../services/cancellation.service";
import { resolveAdminReport } from "../services/admin-report.service";
import { providerStartJob } from "../services/bookings/provider-operations.service";
import { markAdminResolutionStage } from "../services/admin-resolution-operation.service";

test("H1-H5 participant cases remain duplicate-safe, recoverable, and queue-correct", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users: string[] = [];
  const makeUser = async (name: string, role = "user") => {
    const user = await prisma.user.create({ data: { name, email: `${name.replace(/\s/g, "-").toLowerCase()}-${suffix}@example.test`, passwordHash: "test-only", phone: `${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`, location: "Cordova, Cebu", role, emailVerified: true, verificationStatus: "APPROVED" } });
    users.push(user.id);
    return user;
  };

  t.after(async () => {
    const bookingIds = (await prisma.booking.findMany({ where: { OR: [{ seekerId: { in: users } }, { providerId: { in: users } }] }, select: { id: true } })).map((item) => item.id);
    await prisma.adminResolutionOperation.deleteMany({ where: { OR: [{ requestedByAdminId: { in: users } }, { bookingId: { in: bookingIds } }] } });
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: { in: users } }, { targetUserId: { in: users } }] } });
    await prisma.completionEscalation.deleteMany({ where: { requestedBy: { in: users } } });
    await prisma.cancellationRequest.deleteMany({ where: { requestedBy: { in: users } } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: users } }, { reportedUserId: { in: users } }] } });
    await prisma.completedService.deleteMany({ where: { OR: [{ seekerId: { in: users } }, { providerId: { in: users } }] } });
    await prisma.paymentRefund.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await prisma.queue.deleteMany({ where: { seekerId: { in: users } } });
    await prisma.booking.deleteMany({ where: { OR: [{ seekerId: { in: users } }, { providerId: { in: users } }] } });
    await prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await prisma.service.deleteMany({ where: { providerId: { in: users } } });
    await prisma.category.deleteMany({ where: { name: `High priority ${suffix}` } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  const admin = await makeUser("High Admin", "admin");
  const seeker = await makeUser("High Seeker");
  const secondSeeker = await makeUser("High Second Seeker");
  const provider = await makeUser("High Provider");
  const secondProvider = await makeUser("High Second Provider");
  const outsider = await makeUser("High Outsider");
  const category = await prisma.category.create({ data: { name: `High priority ${suffix}` } });
  const service = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Queue ${suffix}`, titleNormalized: `queue ${suffix}`, description: "Queue accounting test", price: 500, estimatedDurationMins: 30, queueLimit: 2, paymentMethods: { cash: false, gcash: true }, status: "ACTIVE", isAvailable: true } });

  // H1 + H5: both participants can report, outsiders cannot, identical
  // incidents dedupe, separate incidents coexist, and Queue stays canonical.
  const servingBooking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: service.id, originType: "DIRECT_LISTING", paymentMethod: "GCash", agreedAmount: 500, paymentStatus: "PAID_HELD", status: "ONGOING", started: true, queuePosition: 1 } });
  await prisma.queue.create({ data: { serviceId: service.id, seekerId: seeker.id, bookingId: servingBooking.id, paymentId: `pi-serving-${suffix}`, paymentStatus: "PAID_HELD", position: 1, status: "SERVING", estimatedWait: 0 } });
  const waitingBooking = await prisma.booking.create({ data: { seekerId: secondSeeker.id, providerId: provider.id, serviceId: service.id, originType: "DIRECT_LISTING", paymentMethod: "GCash", agreedAmount: 500, paymentStatus: "PAID_HELD", status: "WAITING", queuePosition: 2 } });
  await prisma.queue.create({ data: { serviceId: service.id, seekerId: secondSeeker.id, bookingId: waitingBooking.id, paymentId: `pi-waiting-${suffix}`, paymentStatus: "PAID_HELD", position: 2, status: "WAITING", estimatedWait: 30 } });

  const first = await createSafetyReport({ bookingId: servingBooking.id, reporterId: seeker.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "The provider threatened me during the active appointment." });
  const duplicate = await createSafetyReport({ bookingId: servingBooking.id, reporterId: seeker.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "  The provider threatened me during the active appointment.  " });
  const separate = await createSafetyReport({ bookingId: servingBooking.id, reporterId: seeker.id, reason: "SCAM_OR_FRAUD", description: "A separate request for payment outside the agreed booking occurred." });
  const reciprocal = await createSafetyReport({ bookingId: servingBooking.id, reporterId: provider.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "The seeker separately used threatening language in the appointment." });
  assert.equal(first.created, true);
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.created, false);
  assert.notEqual(separate.id, first.id);
  assert.notEqual(reciprocal.id, first.id);
  await assert.rejects(createSafetyReport({ bookingId: servingBooking.id, reporterId: outsider.id, reason: "NO_SHOW", description: "An unrelated person must not report this booking." }), /access denied/i);
  await recalculateQueue(service.id);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: servingBooking.id } })).status, "DISPUTED");
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: servingBooking.id } })).status, "SERVING");
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: waitingBooking.id } })).position, 2);
  await resolveAdminReport(first.id, admin.id, "dismiss", "This incident was not substantiated, but the other active cases remain open.", "none");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: servingBooking.id } })).status, "DISPUTED");
  assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: separate.id } })).status, "PENDING");
  await assert.rejects(resolveAdminReport(separate.id, admin.id, "cancel_booking", "The independent reciprocal case must be resolved first.", "none"), (error: any) => error?.code === "OTHER_BLOCKING_CASES");
  const cashOngoing = await prisma.booking.create({ data: { seekerId: outsider.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 300, paymentStatus: "UNPAID", status: "ONGOING", started: true } });
  assert.equal(await prisma.queue.count({ where: { bookingId: cashOngoing.id } }), 0);
  await createSafetyReport({ bookingId: cashOngoing.id, reporterId: outsider.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "This disputed cash appointment must continue to occupy the provider." });
  const nextCashBooking = await prisma.booking.create({ data: { seekerId: secondSeeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 310, paymentStatus: "UNPAID", status: "ACCEPTED", started: false } });
  await assert.rejects(providerStartJob(nextCashBooking.id, secondProvider.id), (error: any) => error?.code === "PROVIDER_ALREADY_ONGOING");
  await prisma.booking.update({ where: { id: cashOngoing.id }, data: { status: "CANCELED" } });
  await prisma.booking.update({ where: { id: nextCashBooking.id }, data: { status: "CANCELED" } });

  // H3: all three outcomes, durable duplicate resolution, and supersession.
  const oldDate = new Date(Date.now() - 73 * 60 * 60 * 1000);
  const awaitingRelease = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 650, paymentStatus: "UNPAID", status: "AWAITING_CONFIRMATION", started: true, updatedAt: oldDate } });
  const releaseEscalation = await createCompletionEscalation(awaitingRelease.id, secondProvider.id, "The seeker has not responded after the required waiting period.");
  const releaseResults = await Promise.all([
    resolveCompletionEscalation({ escalationId: releaseEscalation.id, adminId: admin.id, action: "release_provider_and_complete", resolution: "Evidence confirms the completed cash service." }),
    resolveCompletionEscalation({ escalationId: releaseEscalation.id, adminId: admin.id, action: "release_provider_and_complete", resolution: "Evidence confirms the completed cash service." }),
  ]);
  assert.equal(releaseResults[0]?.outcome, "RELEASE_PROVIDER_AND_COMPLETE");
  assert.equal(await prisma.completedService.count({ where: { bookingId: awaitingRelease.id } }), 1);
  assert.equal(await prisma.adminResolutionOperation.count({ where: { caseType: "COMPLETION_ESCALATION", caseId: releaseEscalation.id } }), 1);

  const awaitingRefund = await prisma.booking.create({ data: { seekerId: secondSeeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 400, paymentStatus: "UNPAID", status: "AWAITING_CONFIRMATION", started: true, updatedAt: oldDate } });
  const refundEscalation = await createCompletionEscalation(awaitingRefund.id, secondProvider.id, "The completion confirmation has remained unanswered for over 72 hours.");
  await resolveCompletionEscalation({ escalationId: refundEscalation.id, adminId: admin.id, action: "refund_seeker", resolution: "The evidence does not support provider completion." });
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: awaitingRefund.id } })).status, "CANCELED");

  const awaitingKeep = await prisma.booking.create({ data: { seekerId: outsider.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 450, paymentStatus: "UNPAID", status: "AWAITING_CONFIRMATION", started: true, updatedAt: oldDate } });
  const keepEscalation = await createCompletionEscalation(awaitingKeep.id, secondProvider.id, "More documentation is needed after the response window expired.");
  await resolveCompletionEscalation({ escalationId: keepEscalation.id, adminId: admin.id, action: "keep_awaiting", resolution: "Allow the seeker additional time to provide evidence." });
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: awaitingKeep.id } })).status, "AWAITING_CONFIRMATION");
  await assert.rejects(createCompletionEscalation(awaitingKeep.id, secondProvider.id, "A premature duplicate escalation should be blocked by cooldown."), /Wait 72 hours/i);

  const awaitingConfirm = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 475, paymentStatus: "UNPAID", status: "AWAITING_CONFIRMATION", started: true, updatedAt: oldDate } });
  const confirmEscalation = await createCompletionEscalation(awaitingConfirm.id, secondProvider.id, "The seeker has not responded within the required window.");
  await confirmCompletionService(awaitingConfirm.id, seeker.id);
  assert.equal((await prisma.completionEscalation.findUniqueOrThrow({ where: { id: confirmEscalation.id } })).resolution, "SEEKER_CONFIRMED");
  await assert.rejects(resolveCompletionEscalation({ escalationId: confirmEscalation.id, adminId: admin.id, action: "refund_seeker", resolution: "This stale action must not run." }), (error: any) => error?.code === "STALE_ESCALATION");

  const awaitingDispute = await prisma.booking.create({ data: { seekerId: secondSeeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 480, paymentStatus: "UNPAID", status: "AWAITING_CONFIRMATION", started: true, updatedAt: oldDate } });
  const disputeEscalation = await createCompletionEscalation(awaitingDispute.id, secondProvider.id, "The seeker has not responded within the required window.");
  await prisma.adminResolutionOperation.create({ data: { operationKey: `COMPLETION_ESCALATION:${disputeEscalation.id}`, caseType: "COMPLETION_ESCALATION", caseId: disputeEscalation.id, bookingId: awaitingDispute.id, requestedByAdminId: admin.id, requestedOutcome: "refund_seeker", notes: "Claimed immediately before the seeker supplied a dispute.", status: "PROCESSING", stage: "CLAIMED" } });
  await prisma.completionEscalation.update({ where: { id: disputeEscalation.id }, data: { status: "UNDER_REVIEW", adminId: admin.id, resolution: "REFUND_SEEKER" } });
  await disputeJobService(awaitingDispute.id, secondSeeker.id, "INCOMPLETE_SERVICE", "The work is incomplete and requires administrator review.");
  assert.equal((await prisma.completionEscalation.findUniqueOrThrow({ where: { id: disputeEscalation.id } })).resolution, "SUPERSEDED_BY_SEEKER_DISPUTE");
  await assert.rejects(resolveCompletionEscalation({ escalationId: disputeEscalation.id, adminId: admin.id, action: "refund_seeker", resolution: "The stale claimed operation must not settle." }), (error: any) => error?.code === "STALE_ESCALATION");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: awaitingDispute.id } })).status, "DISPUTED");

  // H4: creation and response races serialize; escalations link one exact
  // cancellation Report and never close a separate safety report.
  const cancelBooking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 350, paymentStatus: "UNPAID", status: "ONGOING", started: true } });
  const requests = await Promise.all([
    requestCancellation(cancelBooking.id, seeker.id, "The active visit must stop for a safety-related reason."),
    requestCancellation(cancelBooking.id, seeker.id, "The active visit must stop for a safety-related reason."),
  ]);
  assert.equal(requests[0].request?.id, requests[1].request?.id);
  assert.equal(await prisma.cancellationRequest.count({ where: { bookingId: cancelBooking.id, status: { in: ["PENDING", "DECLINED", "ESCALATED", "UNDER_REVIEW"] } } }), 1);
  const decisionResults = await Promise.allSettled([
    respondToCancellationRequest(requests[0].request!.id, secondProvider.id, true),
    respondToCancellationRequest(requests[0].request!.id, secondProvider.id, false, "The service can continue safely."),
  ]);
  assert.equal(decisionResults.filter((item) => item.status === "fulfilled").length, 1);
  const decidedRequest = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requests[0].request!.id } });
  assert.ok(["APPROVED", "DECLINED"].includes(decidedRequest.status));
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: cancelBooking.id } })).status === "CANCELED", decidedRequest.status === "APPROVED");
  if (decidedRequest.status === "DECLINED") await prisma.booking.update({ where: { id: cancelBooking.id }, data: { status: "CANCELED" } });

  const adminCancelBooking = await prisma.booking.create({ data: { seekerId: outsider.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 525, paymentStatus: "UNPAID", status: "ONGOING", started: true } });
  const adminRequest = await requestCancellation(adminCancelBooking.id, outsider.id, "I need to stop this booking and request administrator review.");
  await respondToCancellationRequest(adminRequest.request!.id, secondProvider.id, false, "I believe the service should continue.");
  await escalateCancellationRequest(adminRequest.request!.id, outsider.id);
  const linked = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: adminRequest.request!.id } });
  assert.ok(linked.reportId);
  const overlappingSafety = await createSafetyReport({ bookingId: adminCancelBooking.id, reporterId: outsider.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "A distinct conduct incident also needs independent review." });
  await assert.rejects(adminResolveCancellationRequest(linked.id, true, "This financial outcome must wait for the independent safety case.", admin.id), (error: any) => error?.code === "OTHER_BLOCKING_CASES");
  await adminResolveCancellationRequest(linked.id, false, "The cancellation evidence does not justify ending the booking.", admin.id);
  assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: linked.reportId! } })).status, "DISMISSED");
  assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: overlappingSafety.id } })).status, "PENDING");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: adminCancelBooking.id } })).status, "DISPUTED");

  const refundFailureService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Refund retry ${suffix}`, titleNormalized: `refund retry ${suffix}`, description: "Failed refund recovery test", price: 575, estimatedDurationMins: 30, queueLimit: 2, paymentMethods: { cash: false, gcash: true }, status: "ACTIVE", isAvailable: true } });
  const refundFailureBooking = await prisma.booking.create({ data: { seekerId: outsider.id, providerId: provider.id, serviceId: refundFailureService.id, originType: "DIRECT_LISTING", paymentMethod: "GCash", agreedAmount: 575, paymentStatus: "PAID_HELD", status: "ONGOING", started: true, queuePosition: 1 } });
  await prisma.queue.create({ data: { serviceId: refundFailureService.id, seekerId: outsider.id, bookingId: refundFailureBooking.id, paymentId: `pi-refund-failure-${suffix}`, paymongoPaymentId: `pay-refund-failure-${suffix}`, paymentStatus: "PAID_HELD", position: 1, status: "SERVING", estimatedWait: 0 } });
  const failedRefundRequest = await requestCancellation(refundFailureBooking.id, outsider.id, "The active paid booking must be cancelled.");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Simulated PayMongo outage"); }) as typeof fetch;
  try {
    await assert.rejects(respondToCancellationRequest(failedRefundRequest.request!.id, provider.id, true), /PayMongo is unavailable/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: failedRefundRequest.request!.id } })).status, "UNDER_REVIEW");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: refundFailureBooking.id } })).status, "ONGOING");
  assert.equal((await prisma.adminResolutionOperation.findUniqueOrThrow({ where: { caseType_caseId: { caseType: "CANCELLATION", caseId: failedRefundRequest.request!.id } } })).status, "FAILED_RETRYABLE");
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(`/payment_intents/pi-refund-failure-${suffix}`)) return new Response(JSON.stringify({ data: { id: `pi-refund-failure-${suffix}`, attributes: { status: "succeeded", amount: 57_500, currency: "PHP", metadata: {}, payments: [{ id: `pay-refund-failure-${suffix}` }] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected mocked PayMongo request: ${url}`);
  }) as typeof fetch;
  try {
    await respondToCancellationRequest(failedRefundRequest.request!.id, provider.id, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: refundFailureBooking.id } })).paymentStatus, "REFUNDED");
  assert.equal(await prisma.paymentRefund.count({ where: { bookingId: refundFailureBooking.id } }), 1);

  // H2 recovery: emulate an interruption after cancellation settlement but
  // before case closure; retry resumes the same durable operation and audit.
  const recoveredBooking = await prisma.booking.create({ data: { seekerId: secondSeeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 250, paymentStatus: "UNPAID", status: "CANCELED", started: true } });
  const recoveredReport = await prisma.report.create({ data: { bookingId: recoveredBooking.id, reporterId: secondSeeker.id, reportedUserId: secondProvider.id, reason: "INCOMPLETE_SERVICE", description: "Recovery test after financial settlement was established.", reportType: "SAFETY", status: "UNDER_REVIEW", adminId: admin.id } });
  await prisma.adminResolutionOperation.create({ data: { operationKey: `REPORT:${recoveredReport.id}`, caseType: "REPORT", caseId: recoveredReport.id, bookingId: recoveredBooking.id, requestedByAdminId: admin.id, requestedOutcome: "cancel_booking", requestedPenalty: "none", notes: "Resume the interrupted cancellation decision.", status: "FAILED_RETRYABLE", stage: "FINANCIAL_EFFECT_ESTABLISHED", lastError: "Simulated process interruption" } });
  const recovered = await resolveAdminReport(recoveredReport.id, admin.id, "cancel_booking", "Resume the interrupted cancellation decision.", "none");
  const repeated = await resolveAdminReport(recoveredReport.id, admin.id, "cancel_booking", "Response was lost; return the established result.", "none");
  assert.deepEqual(repeated, recovered);
  assert.equal(await prisma.adminResolutionOperation.count({ where: { caseType: "REPORT", caseId: recoveredReport.id } }), 1);
  assert.equal(await prisma.adminAuditLog.count({ where: { resourceType: "Report", resourceId: recoveredReport.id } }), 1);

  // Re-audit gap 1: release settlement is authoritative after statusBeforeDispute
  // has been cleared, so a closure-only retry cannot settle twice.
  const releasedBooking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 610, paymentStatus: "CASH_CONFIRMED", status: "COMPLETED", started: true } });
  await prisma.completedService.create({ data: { bookingId: releasedBooking.id, seekerId: seeker.id, providerId: secondProvider.id, finalPrice: 610, paymentStatus: "CASH_CONFIRMED" } });
  const releasedReport = await prisma.report.create({ data: { bookingId: releasedBooking.id, reporterId: seeker.id, reportedUserId: secondProvider.id, reason: "INCOMPLETE_SERVICE", description: "Closure was interrupted after provider release.", reportType: "COMPLETION_DISPUTE", status: "UNDER_REVIEW", adminId: admin.id } });
  await prisma.adminResolutionOperation.create({ data: { operationKey: `REPORT:${releasedReport.id}`, caseType: "REPORT", caseId: releasedReport.id, bookingId: releasedBooking.id, requestedByAdminId: admin.id, requestedOutcome: "release_provider_and_complete", requestedPenalty: "none", notes: "Resume release closure.", status: "FAILED_RETRYABLE", stage: "FINANCIAL_EFFECT_ESTABLISHED" } });
  await resolveAdminReport(releasedReport.id, admin.id, "release_provider_and_complete", "Resume release closure.", "none");
  assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: releasedReport.id } })).status, "RESOLVED");
  assert.equal(await prisma.completedService.count({ where: { bookingId: releasedBooking.id } }), 1);

  // Re-audit gap 2: both completion-escalation financial outcomes resume from
  // terminal booking state once the durable operation establishes the effect.
  for (const action of ["release_provider_and_complete", "refund_seeker"] as const) {
    const terminalBooking = await prisma.booking.create({ data: { seekerId: secondSeeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 620, paymentStatus: action === "release_provider_and_complete" ? "CASH_CONFIRMED" : "UNPAID", status: action === "release_provider_and_complete" ? "COMPLETED" : "CANCELED", started: true } });
    if (action === "release_provider_and_complete") await prisma.completedService.create({ data: { bookingId: terminalBooking.id, seekerId: secondSeeker.id, providerId: secondProvider.id, finalPrice: 620, paymentStatus: "CASH_CONFIRMED" } });
    const escalation = await prisma.completionEscalation.create({ data: { bookingId: terminalBooking.id, requestedBy: secondProvider.id, reason: "Post-settlement recovery", status: "UNDER_REVIEW", adminId: admin.id, resolution: action === "release_provider_and_complete" ? "RELEASE_PROVIDER_AND_COMPLETE" : "REFUND_SEEKER" } });
    await prisma.adminResolutionOperation.create({ data: { operationKey: `COMPLETION_ESCALATION:${escalation.id}`, caseType: "COMPLETION_ESCALATION", caseId: escalation.id, bookingId: terminalBooking.id, requestedByAdminId: admin.id, requestedOutcome: action, notes: `Resume ${action}`, status: "FAILED_RETRYABLE", stage: "FINANCIAL_EFFECT_ESTABLISHED" } });
    const resumed = await resolveCompletionEscalation({ escalationId: escalation.id, adminId: admin.id, action, resolution: `Resume ${action}` });
    assert.equal(resumed.outcome, action === "release_provider_and_complete" ? "RELEASE_PROVIDER_AND_COMPLETE" : "REFUND_SEEKER");
    assert.equal((await prisma.completionEscalation.findUniqueOrThrow({ where: { id: escalation.id } })).status, "RESOLVED");
    assert.equal(await prisma.completedService.count({ where: { bookingId: terminalBooking.id } }), action === "release_provider_and_complete" ? 1 : 0);
  }

  // Re-audit gap 3: stale workers cannot move a completed operation backwards.
  const stageCaseId = `stage-cas-${suffix}`;
  const stageOperation = await prisma.adminResolutionOperation.create({ data: { operationKey: `REPORT:${stageCaseId}`, caseType: "REPORT", caseId: stageCaseId, bookingId: releasedBooking.id, requestedByAdminId: admin.id, requestedOutcome: "dismiss", notes: "CAS stage test" } });
  await prisma.adminResolutionOperation.update({ where: { id: stageOperation.id }, data: { status: "COMPLETED", stage: "CASE_FINALIZED", result: { resolved: true }, completedAt: new Date() } });
  await markAdminResolutionStage(stageOperation.id, "DECISION_READY");
  const terminalOperation = await prisma.adminResolutionOperation.findUniqueOrThrow({ where: { id: stageOperation.id } });
  assert.equal(terminalOperation.status, "COMPLETED");
  assert.equal(terminalOperation.stage, "CASE_FINALIZED");

  // Re-audit gap 4: either blocker resolution order restores the same state.
  await resolveAdminReport(overlappingSafety.id, admin.id, "dismiss", "The separate safety case is dismissed.", "none");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: adminCancelBooking.id } })).status, "ONGOING");

  const reverseOrderBooking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 530, paymentStatus: "UNPAID", status: "ONGOING", started: true } });
  const reverseRequest = await requestCancellation(reverseOrderBooking.id, seeker.id, "Test the reverse blocker resolution order.");
  await respondToCancellationRequest(reverseRequest.request!.id, provider.id, false, "Continue the service.");
  await escalateCancellationRequest(reverseRequest.request!.id, seeker.id);
  const reverseSafety = await createSafetyReport({ bookingId: reverseOrderBooking.id, reporterId: seeker.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "A separate safety case is resolved before cancellation." });
  await resolveAdminReport(reverseSafety.id, admin.id, "dismiss", "Dismiss safety first while cancellation remains active.", "none");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: reverseOrderBooking.id } })).status, "DISPUTED");
  await adminResolveCancellationRequest(reverseRequest.request!.id, false, "Deny cancellation after safety dismissal.", admin.id);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: reverseOrderBooking.id } })).status, "ONGOING");

  // Re-audit gap 5: provider Start and pre-start cancellation serialize on the
  // same booking lock, and interrupted request finalization is repairable.
  const raceBooking = await prisma.booking.create({ data: { seekerId: outsider.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 275, paymentStatus: "UNPAID", status: "ACCEPTED", started: false } });
  await Promise.allSettled([
    providerStartJob(raceBooking.id, secondProvider.id),
    requestCancellation(raceBooking.id, outsider.id, "Cancel before the service starts."),
  ]);
  const raced = await prisma.booking.findUniqueOrThrow({ where: { id: raceBooking.id } });
  assert.equal(raced.status === "CANCELED" && raced.started, false);
  if (raced.status === "ONGOING") {
    assert.equal(raced.started, true);
    assert.equal(await prisma.cancellationRequest.count({ where: { bookingId: raced.id, status: "PENDING" } }), 1);
  }

  const interruptedImmediate = await prisma.booking.create({ data: { seekerId: outsider.id, providerId: provider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 280, paymentStatus: "UNPAID", status: "CANCELED", started: false } });
  const interruptedRequest = await prisma.cancellationRequest.create({ data: { bookingId: interruptedImmediate.id, requestedBy: outsider.id, responderId: provider.id, reason: "Settlement committed before request closure.", status: "UNDER_REVIEW", resolutionOutcome: "IMMEDIATE_CANCEL_PENDING" } });
  await requestCancellation(interruptedImmediate.id, outsider.id, "Retry finalization.");
  assert.equal((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: interruptedRequest.id } })).status, "APPROVED");

  // Re-audit gap 6: completion financial reservation sees every other case.
  const blockedEscalationBooking = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: secondProvider.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 640, paymentStatus: "UNPAID", status: "AWAITING_CONFIRMATION", started: true, updatedAt: oldDate } });
  const blockedEscalation = await createCompletionEscalation(blockedEscalationBooking.id, secondProvider.id, "Awaiting response for more than 72 hours.");
  await prisma.report.create({ data: { bookingId: blockedEscalationBooking.id, reporterId: seeker.id, reportedUserId: secondProvider.id, reason: "INAPPROPRIATE_BEHAVIOR", description: "Independent active blocker.", reportType: "SAFETY", status: "PENDING" } });
  await assert.rejects(resolveCompletionEscalation({ escalationId: blockedEscalation.id, adminId: admin.id, action: "refund_seeker", resolution: "Must not reserve while another case is active." }), (error: any) => error?.code === "OTHER_BLOCKING_CASES");
});
