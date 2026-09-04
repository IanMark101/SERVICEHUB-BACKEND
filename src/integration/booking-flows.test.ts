import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { createDirectFromOfferService, createDirectRequest, respondToDirectBookingService } from "../services/bookings/direct-bookings.service";
import { confirmCompletionService, disputeJobService, markJobComplete } from "../services/bookings/completion.service";
import { providerStartJob } from "../services/bookings/provider-operations.service";
import { expireStalePaymentAttempts, finalizeSuccessfulPayment, markPaymentAttemptFailed } from "../services/payment-attempt.service";
import { resolveAdminReport } from "../services/admin-report.service";
import { requestCancellation } from "../services/cancellation.service";

test("defense-critical cash, paid queue, and completion flows", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tracked = { users: [] as string[], services: [] as string[], requests: [] as string[], attempts: [] as string[] };

  t.after(async () => {
    if (tracked.users.length) {
      await prisma.completionEscalation.deleteMany({ where: { requestedBy: { in: tracked.users } } });
      await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: { in: tracked.users } }, { targetUserId: { in: tracked.users } }] } });
      await prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: tracked.users } }, { reportedUserId: { in: tracked.users } }] } });
      await prisma.completedService.deleteMany({ where: { OR: [{ seekerId: { in: tracked.users } }, { providerId: { in: tracked.users } }] } });
      await prisma.paymentRefund.deleteMany({ where: { requestedById: { in: tracked.users } } });
      await prisma.queue.deleteMany({ where: { seekerId: { in: tracked.users } } });
      await prisma.booking.deleteMany({ where: { OR: [{ seekerId: { in: tracked.users } }, { providerId: { in: tracked.users } }] } });
      await prisma.paymentAttempt.deleteMany({ where: { seekerId: { in: tracked.users } } });
      await prisma.offer.deleteMany({ where: { providerId: { in: tracked.users } } });
      await prisma.serviceRequest.deleteMany({ where: { seekerId: { in: tracked.users } } });
      await prisma.directRequest.deleteMany({ where: { OR: [{ seekerId: { in: tracked.users } }, { providerId: { in: tracked.users } }] } });
      await prisma.service.deleteMany({ where: { providerId: { in: tracked.users } } });
      await prisma.user.deleteMany({ where: { id: { in: tracked.users } } });
    }
    await prisma.category.deleteMany({ where: { name: `Integration ${suffix}` } });
    await prisma.$disconnect();
  });

  const category = await prisma.category.create({ data: { name: `Integration ${suffix}` } });
  const seeker = await prisma.user.create({ data: { name: "Integration Seeker", email: `seeker-${suffix}@example.test`, passwordHash: "test-only", phone: `09${Date.now().toString().slice(-9)}`, location: "Cordova, Cebu", emailVerified: true, verificationStatus: "APPROVED" } });
  const secondSeeker = await prisma.user.create({ data: { name: "Integration Second Seeker", email: `seeker2-${suffix}@example.test`, passwordHash: "test-only", phone: `07${Date.now().toString().slice(-9)}`, location: "Cordova, Cebu", emailVerified: true, verificationStatus: "APPROVED" } });
  const provider = await prisma.user.create({ data: { name: "Integration Provider", email: `provider-${suffix}@example.test`, passwordHash: "test-only", phone: `08${Date.now().toString().slice(-9)}`, location: "Cordova, Cebu", emailVerified: true, verificationStatus: "APPROVED" } });
  const admin = await prisma.user.create({ data: { name: "Integration Admin", email: `admin-${suffix}@example.test`, passwordHash: "test-only", phone: `06${Date.now().toString().slice(-9)}`, location: "Cordova, Cebu", role: "admin", emailVerified: true, verificationStatus: "APPROVED" } });
  tracked.users.push(seeker.id, secondSeeker.id, provider.id, admin.id);

  const cashService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Cash ${suffix}`, description: "Integration cash service", price: 500, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true, gcash: false, maya: false }, status: "ACTIVE", isAvailable: true } });
  const offerCashService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Offer cash ${suffix}`, description: "Integration offer cash service", price: 650, priceType: "STARTS_AT", serviceType: "ONE_TIME", estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true, gcash: false, maya: false }, status: "ACTIVE", isAvailable: true } });
  const queueService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Queue ${suffix}`, description: "Integration queue service", price: 700, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 45, queueLimit: 3, paymentMethods: { cash: true, gcash: true, maya: false }, status: "ACTIVE", isAvailable: true } });
  const capacityService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Capacity ${suffix}`, description: "Integration capacity service", price: 800, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 45, queueLimit: 1, paymentMethods: { cash: false, gcash: true, maya: false }, status: "ACTIVE", isAvailable: true } });
  tracked.services.push(cashService.id, offerCashService.id, queueService.id, capacityService.id);

  await assert.rejects(
    createDirectRequest({ seekerId: provider.id, providerId: provider.id, serviceId: cashService.id }),
    (error: any) => error?.code === "SELF_TRANSACTION_NOT_ALLOWED" && error?.status === 403,
  );

  // Flow A: direct listing + on-site cash; no Queue and no wallet earning.
  const direct = await createDirectRequest({ seekerId: seeker.id, providerId: provider.id, serviceId: cashService.id });
  const acceptedCash = await respondToDirectBookingService(direct.id, provider.id, true);
  assert.equal(acceptedCash.paymentStatus, "UNPAID");
  assert.equal(await prisma.queue.count({ where: { bookingId: acceptedCash.id } }), 0);
  await assert.rejects(providerStartJob(acceptedCash.id, secondSeeker.id), /access denied/i);
  await providerStartJob(acceptedCash.id, provider.id);
  await markJobComplete(acceptedCash.id, provider.id);
  const completedCash = await confirmCompletionService(acceptedCash.id, seeker.id);
  assert.equal(completedCash.paymentStatus, "CASH_CONFIRMED");
  assert.equal(await prisma.transaction.count({ where: { relatedBookingId: completedCash.id } }), 0);

  const declinedDirect = await createDirectRequest({ seekerId: seeker.id, providerId: provider.id, serviceId: cashService.id });
  const declinedBooking = await respondToDirectBookingService(declinedDirect.id, provider.id, false);
  assert.equal(declinedBooking?.status, "DECLINED");
  assert.equal(await prisma.queue.count({ where: { bookingId: declinedBooking?.id } }), 0);

  // Flow B: the offer is bound to the exact provider listing; cash stays out of Queue.
  const request = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id, title: `Request ${suffix}`, description: "Integration request description", budgetMin: 500, budgetMax: 900, urgency: "medium" } });
  tracked.requests.push(request.id);
  const sibling = await prisma.offer.create({ data: { requestId: request.id, providerId: provider.id, serviceId: cashService.id, offeredPrice: 650, estimatedDuration: 60 } });
  const selected = await prisma.offer.create({ data: { requestId: request.id, providerId: provider.id, serviceId: offerCashService.id, offeredPrice: 700, estimatedDuration: 60 } });
  const flowBCash = await createDirectFromOfferService(selected.id, seeker.id);
  assert.equal(flowBCash.serviceId, offerCashService.id);
  assert.equal(Number(flowBCash.agreedAmount), 700);
  assert.equal(flowBCash.paymentStatus, "UNPAID");
  assert.equal(await prisma.queue.count({ where: { bookingId: flowBCash.id } }), 0);
  assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: sibling.id } })).status, "REJECTED");
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: request.id } })).status, "IN_PROGRESS");

  // An abandoned Flow B checkout releases its exact offer and request hold.
  const expiringRequest = await prisma.serviceRequest.create({ data: { seekerId: secondSeeker.id, categoryId: category.id, title: `Expiring ${suffix}`, description: "Integration expiring payment request", budgetMin: 500, budgetMax: 900, urgency: "medium", status: "PAYMENT_PENDING" } });
  const expiringOffer = await prisma.offer.create({ data: { requestId: expiringRequest.id, providerId: provider.id, serviceId: queueService.id, offeredPrice: 700, estimatedDuration: 60, status: "PENDING_PAYMENT", paymentHoldExpiresAt: new Date(Date.now() - 60_000) } });
  await prisma.paymentAttempt.create({ data: { idempotencyKey: `expired-${suffix}`, seekerId: secondSeeker.id, providerId: provider.id, serviceId: queueService.id, offerId: expiringOffer.id, providerIntentId: `pi_expired_${suffix}`, amount: 700, paymentMethod: "gcash", expiresAt: new Date(Date.now() - 30_000) } });
  assert.ok((await expireStalePaymentAttempts()) >= 1);
  assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: expiringOffer.id } })).status, "PENDING");
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: expiringRequest.id } })).status, "OPEN");

  const failedRequest = await prisma.serviceRequest.create({ data: { seekerId: secondSeeker.id, categoryId: category.id, title: `Failed ${suffix}`, description: "Integration failed payment request", budgetMin: 500, budgetMax: 900, urgency: "medium", status: "PAYMENT_PENDING" } });
  const failedOffer = await prisma.offer.create({ data: { requestId: failedRequest.id, providerId: provider.id, serviceId: queueService.id, offeredPrice: 700, estimatedDuration: 60, status: "PENDING_PAYMENT", paymentHoldExpiresAt: new Date(Date.now() + 60_000) } });
  const failedAttempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `failed-${suffix}`, seekerId: secondSeeker.id, providerId: provider.id, serviceId: queueService.id, offerId: failedOffer.id, providerIntentId: `pi_failed_${suffix}`, amount: 700, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 60_000) } });
  await markPaymentAttemptFailed(`pi_failed_${suffix}`, "payment.failed");
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: failedAttempt.id } })).status, "FAILED");
  assert.equal((await prisma.offer.findUniqueOrThrow({ where: { id: failedOffer.id } })).status, "PENDING");
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: failedRequest.id } })).status, "OPEN");
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: failedAttempt.id } }), 0);

  // Webhook-style paid booking: exact metadata, FCFS queue, one completion credit.
  const attempt = await prisma.paymentAttempt.create({
    data: { idempotencyKey: `integration-${suffix}`, seekerId: seeker.id, providerId: provider.id, serviceId: queueService.id, providerIntentId: `pi_${suffix}`, providerPaymentId: `pay_${suffix}`, amount: 700, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 60_000) },
  });
  tracked.attempts.push(attempt.id);
  const finalized = await finalizeSuccessfulPayment({
    paymentIntentId: `pi_${suffix}`,
    paymentId: `pay_${suffix}`,
    amount: 700,
    currency: "PHP",
    metadata: { servicehub_attempt_id: attempt.id, servicehub_seeker_id: seeker.id, servicehub_service_id: queueService.id, servicehub_offer_id: "", servicehub_expected_amount: "700.00", servicehub_payment_method: "gcash" },
  });
  assert.equal(finalized.created, true);
  assert.equal(finalized.booking?.status, "ACCEPTED");
  assert.equal(finalized.queue?.position, 1);

  const duplicateFinalize = await finalizeSuccessfulPayment({
    paymentIntentId: `pi_${suffix}`,
    paymentId: `pay_${suffix}`,
    amount: 700,
    currency: "PHP",
    metadata: { servicehub_attempt_id: attempt.id, servicehub_seeker_id: seeker.id, servicehub_service_id: queueService.id, servicehub_offer_id: "", servicehub_expected_amount: "700.00", servicehub_payment_method: "gcash" },
  });
  assert.equal(duplicateFinalize.created, false);
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: attempt.id } }), 1);
  assert.equal(await prisma.queue.count({ where: { paymentId: `pi_${suffix}` } }), 1);

  const secondAttempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `integration-second-${suffix}`, seekerId: secondSeeker.id, providerId: provider.id, serviceId: queueService.id, providerIntentId: `pi_second_${suffix}`, amount: 700, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 60_000) } });
  const secondFinalized = await finalizeSuccessfulPayment({
    paymentIntentId: `pi_second_${suffix}`,
    paymentId: `pay_second_${suffix}`,
    amount: 700,
    currency: "PHP",
    metadata: { servicehub_attempt_id: secondAttempt.id, servicehub_seeker_id: secondSeeker.id, servicehub_service_id: queueService.id, servicehub_offer_id: "", servicehub_expected_amount: "700.00", servicehub_payment_method: "gcash" },
  });
  assert.equal(secondFinalized.queue?.position, 2);
  await assert.rejects(providerStartJob(secondFinalized.booking!.id, provider.id), /first waiting booking/i);

  const onlineBookingId = finalized.booking!.id;
  await providerStartJob(onlineBookingId, provider.id);
  await assert.rejects(
    providerStartJob(flowBCash.id, provider.id),
    (error: any) => error?.code === "PROVIDER_ALREADY_ONGOING" && error?.status === 409,
  );
  await markJobComplete(onlineBookingId, provider.id);
  const firstSettlement = await confirmCompletionService(onlineBookingId, seeker.id);
  const repeatedSettlement = await confirmCompletionService(onlineBookingId, seeker.id);
  assert.equal(repeatedSettlement.id, firstSettlement.id);
  assert.equal(firstSettlement.paymentStatus, "RELEASED");
  assert.equal(await prisma.transaction.count({ where: { idempotencyKey: `booking-completion:${onlineBookingId}` } }), 1);
  assert.equal(await prisma.trustScoreEvent.count({ where: { eventKey: `booking-completion:${onlineBookingId}:provider` } }), 1);
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: onlineBookingId } })).status, "DONE");
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: secondFinalized.booking!.id } })).position, 1);

  // Cancelling an unstarted paid row retains history, refunds once, and closes
  // the position gap without contacting a real gateway in this integration run.
  const thirdAttempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `integration-third-${suffix}`, seekerId: seeker.id, providerId: provider.id, serviceId: queueService.id, providerIntentId: `pi_third_${suffix}`, amount: 700, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 60_000) } });
  const thirdFinalized = await finalizeSuccessfulPayment({
    paymentIntentId: `pi_third_${suffix}`,
    paymentId: `pay_third_${suffix}`,
    amount: 700,
    currency: "PHP",
    metadata: { servicehub_attempt_id: thirdAttempt.id, servicehub_seeker_id: seeker.id, servicehub_service_id: queueService.id, servicehub_offer_id: "", servicehub_expected_amount: "700.00", servicehub_payment_method: "gcash" },
  });
  assert.equal(thirdFinalized.queue?.position, 2);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/payment_intents/pi_second_${suffix}`)) {
      return new Response(JSON.stringify({ data: { id: `pi_second_${suffix}`, attributes: { status: "succeeded", amount: 70_000, currency: "PHP", metadata: {}, payments: [{ id: `pay_second_${suffix}` }] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/refunds") && init?.method === "POST") {
      return new Response(JSON.stringify({ data: { id: `refund_second_${suffix}`, attributes: { status: "succeeded" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected mocked PayMongo request: ${url}`);
  }) as typeof fetch;
  try {
    const cancelled = await requestCancellation(secondFinalized.booking!.id, secondSeeker.id, "No longer need the service.");
    assert.equal(cancelled.immediate, true);
    const duplicateCancellation = await requestCancellation(secondFinalized.booking!.id, secondSeeker.id, "Duplicate request.");
    assert.equal(duplicateCancellation.alreadyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: secondFinalized.booking!.id } })).paymentStatus, "REFUNDED");
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: secondFinalized.booking!.id } })).status, "CANCELLED");
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: thirdFinalized.booking!.id } })).position, 1);
  assert.equal(await prisma.paymentRefund.count({ where: { bookingId: secondFinalized.booking!.id } }), 1);
  assert.equal(await prisma.transaction.count({ where: { idempotencyKey: `booking-refund:${secondFinalized.booking!.id}` } }), 1);

  // If capacity disappears after capture, the webhook creates no booking and
  // records an explicit refund requirement for administrator reconciliation.
  const capacityBlocker = await prisma.booking.create({ data: { seekerId: seeker.id, providerId: provider.id, serviceId: capacityService.id, originType: "DIRECT_LISTING", paymentMethod: "GCash", agreedAmount: 800, paymentStatus: "PAID_HELD", status: "ACCEPTED" } });
  await prisma.queue.create({ data: { serviceId: capacityService.id, seekerId: seeker.id, paymentId: `pi_blocker_${suffix}`, paymentStatus: "PAID_HELD", position: 1, status: "WAITING", estimatedWait: 0, bookingId: capacityBlocker.id } });
  const capacityAttempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `capacity-${suffix}`, seekerId: secondSeeker.id, providerId: provider.id, serviceId: capacityService.id, providerIntentId: `pi_capacity_${suffix}`, amount: 800, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 60_000) } });
  const capacityResult = await finalizeSuccessfulPayment({
    paymentIntentId: `pi_capacity_${suffix}`,
    paymentId: `pay_capacity_${suffix}`,
    amount: 800,
    currency: "PHP",
    metadata: { servicehub_attempt_id: capacityAttempt.id, servicehub_seeker_id: secondSeeker.id, servicehub_service_id: capacityService.id, servicehub_offer_id: "", servicehub_expected_amount: "800.00", servicehub_payment_method: "gcash" },
  });
  assert.equal(capacityResult.refundRequired, true);
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: capacityAttempt.id } }), 0);
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: capacityAttempt.id } })).status, "REFUND_REQUIRED");

  const suspensionReport = await prisma.report.create({ data: { bookingId: capacityBlocker.id, reporterId: seeker.id, reportedUserId: provider.id, reason: "NO_SHOW", description: "Administrative suspension guard integration case." } });
  await assert.rejects(
    resolveAdminReport(suspensionReport.id, admin.id, "suspend", "Temporary suspension requested by integration test."),
    /Resolve or administratively cancel/i,
  );
  assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: suspensionReport.id } })).status, "PENDING");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: provider.id } })).moderationStatus, "ACTIVE");

  // Administrator dispute release is a real database transition, is audited,
  // and cannot settle the same report twice.
  const disputedDirect = await createDirectRequest({ seekerId: secondSeeker.id, providerId: provider.id, serviceId: cashService.id });
  const disputedBooking = await respondToDirectBookingService(disputedDirect.id, provider.id, true);
  await providerStartJob(disputedBooking.id, provider.id);
  await markJobComplete(disputedBooking.id, provider.id);
  const report = await disputeJobService(disputedBooking.id, secondSeeker.id, "INCOMPLETE_SERVICE", "The completion requires administrator review.");
  const adminResolution = await resolveAdminReport(report.id, admin.id, "release_provider_and_complete", "Evidence supports completion and release.");
  assert.equal(adminResolution.resolved, true);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: disputedBooking.id } })).status, "COMPLETED");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: disputedBooking.id } })).paymentStatus, "CASH_CONFIRMED");
  assert.equal(await prisma.adminAuditLog.count({ where: { actorId: admin.id, resourceId: report.id, action: "REPORT_RELEASE_PROVIDER_AND_COMPLETE" } }), 1);
  await assert.rejects(resolveAdminReport(report.id, admin.id, "release_provider_and_complete", "Duplicate resolution attempt."), /already been resolved/i);
});
