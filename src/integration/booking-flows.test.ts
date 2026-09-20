import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { createDirectFromOfferService, createDirectRequest, respondToDirectBookingService } from "../services/bookings/direct-bookings.service";
import { confirmCompletionService, disputeJobService, markJobComplete } from "../services/bookings/completion.service";
import { providerStartJob } from "../services/bookings/provider-operations.service";
import { expireStalePaymentAttempts, finalizeSuccessfulPayment, markPaymentAttemptFailed, refundCapturedAttempt } from "../services/payment-attempt.service";
import { resolveAdminReport } from "../services/admin-report.service";
import { requestCancellation } from "../services/cancellation.service";
import { cancelRequest } from "../services/requests.service";

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

  const cashService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Cash ${suffix}`, titleNormalized: `cash ${suffix}`.toLowerCase(), description: "Integration cash service", price: 500, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true, gcash: false }, status: "ACTIVE", isAvailable: true } });
  const offerCashService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Offer cash ${suffix}`, titleNormalized: `offer cash ${suffix}`.toLowerCase(), description: "Integration offer cash service", price: 650, priceType: "STARTS_AT", serviceType: "ONE_TIME", estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { cash: true, gcash: false }, status: "ACTIVE", isAvailable: true } });
  const queueService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Queue ${suffix}`, titleNormalized: `queue ${suffix}`.toLowerCase(), description: "Integration queue service", price: 700, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 45, queueLimit: 3, paymentMethods: { cash: true, gcash: true }, status: "ACTIVE", isAvailable: true } });
  const capacityService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Capacity ${suffix}`, titleNormalized: `capacity ${suffix}`.toLowerCase(), description: "Integration capacity service", price: 800, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 45, queueLimit: 1, paymentMethods: { cash: false, gcash: true }, status: "ACTIVE", isAvailable: true } });
  const requestRaceService = await prisma.service.create({ data: { providerId: provider.id, categoryId: category.id, title: `Request race ${suffix}`, titleNormalized: `request race ${suffix}`.toLowerCase(), description: "Request cancellation race service", price: 725, priceType: "FIXED", serviceType: "ONE_TIME", estimatedDurationMins: 45, queueLimit: 3, paymentMethods: { cash: true, gcash: true }, status: "ACTIVE", isAvailable: true } });
  tracked.services.push(cashService.id, offerCashService.id, queueService.id, capacityService.id, requestRaceService.id);

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

  // C3 regression: two concurrent cash selections for sibling offers share the
  // request lock. Exactly one can create a booking and the loser is rejected.
  const competingRequest = await prisma.serviceRequest.create({ data: { seekerId: secondSeeker.id, categoryId: category.id, title: `Competing ${suffix}`, description: "Concurrent sibling selection case", budgetMin: 500, budgetMax: 900, urgency: "medium" } });
  const competingOfferA = await prisma.offer.create({ data: { requestId: competingRequest.id, providerId: provider.id, serviceId: cashService.id, offeredPrice: 600, estimatedDuration: 60 } });
  const competingOfferB = await prisma.offer.create({ data: { requestId: competingRequest.id, providerId: provider.id, serviceId: offerCashService.id, offeredPrice: 700, estimatedDuration: 60 } });
  const competingResults = await Promise.allSettled([
    createDirectFromOfferService(competingOfferA.id, secondSeeker.id),
    createDirectFromOfferService(competingOfferB.id, secondSeeker.id),
  ]);
  assert.equal(competingResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(competingResults.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await prisma.offer.count({ where: { requestId: competingRequest.id, status: "ACCEPTED" } }), 1);
  assert.equal(await prisma.offer.count({ where: { requestId: competingRequest.id, status: "REJECTED" } }), 1);
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: competingRequest.id } })).status, "IN_PROGRESS");
  const competingWinner = competingResults.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createDirectFromOfferService>>> => result.status === "fulfilled");
  assert.ok(competingWinner);
  await requestCancellation(competingWinner.value.id, secondSeeker.id, "Integration cleanup after concurrency assertion.");

  // Re-audit Flow B: cash selection and request cancellation share request
  // coordination. Exactly one terminal decision can commit.
  const cancelRaceRequest = await prisma.serviceRequest.create({ data: { seekerId: secondSeeker.id, categoryId: category.id, title: `Cancel race ${suffix}`, description: "Cash selection versus cancellation", budgetMin: 500, budgetMax: 900, urgency: "medium" } });
  const cancelRaceOffer = await prisma.offer.create({ data: { requestId: cancelRaceRequest.id, providerId: provider.id, serviceId: requestRaceService.id, offeredPrice: 725, estimatedDuration: 60 } });
  const cancelRace = await Promise.allSettled([
    createDirectFromOfferService(cancelRaceOffer.id, secondSeeker.id),
    cancelRequest(cancelRaceRequest.id, secondSeeker.id),
  ]);
  assert.equal(cancelRace.filter((result) => result.status === "fulfilled").length, 1);
  const cancelRaceState = await prisma.serviceRequest.findUniqueOrThrow({ where: { id: cancelRaceRequest.id } });
  assert.ok(["IN_PROGRESS", "CANCELED"].includes(cancelRaceState.status));
  assert.equal(await prisma.booking.count({ where: { offerId: cancelRaceOffer.id } }), cancelRaceState.status === "IN_PROGRESS" ? 1 : 0);

  // A successful captured hold cannot be overwritten by cancellation.
  const capturedRequest = await prisma.serviceRequest.create({ data: { seekerId: seeker.id, categoryId: category.id, title: `Captured race ${suffix}`, description: "Capture finalization versus cancellation", budgetMin: 500, budgetMax: 900, urgency: "medium", status: "PAYMENT_PENDING" } });
  const capturedOffer = await prisma.offer.create({ data: { requestId: capturedRequest.id, providerId: provider.id, serviceId: requestRaceService.id, offeredPrice: 725, estimatedDuration: 60, status: "PENDING_PAYMENT", paymentHoldExpiresAt: new Date(Date.now() + 60_000) } });
  const capturedAttempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `captured-race-${suffix}`, seekerId: seeker.id, providerId: provider.id, serviceId: requestRaceService.id, offerId: capturedOffer.id, providerIntentId: `pi_captured_race_${suffix}`, amount: 725, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 60_000) } });
  const captureRace = await Promise.allSettled([
    finalizeSuccessfulPayment({ paymentIntentId: `pi_captured_race_${suffix}`, paymentId: `pay_captured_race_${suffix}`, amount: 725, currency: "PHP", metadata: { servicehub_attempt_id: capturedAttempt.id, servicehub_seeker_id: seeker.id, servicehub_service_id: requestRaceService.id, servicehub_offer_id: capturedOffer.id, servicehub_expected_amount: "725.00", servicehub_payment_method: "gcash" } }),
    cancelRequest(capturedRequest.id, seeker.id),
  ]);
  assert.equal(captureRace[0].status, "fulfilled");
  assert.equal(captureRace[1].status, "rejected");
  assert.equal((await prisma.serviceRequest.findUniqueOrThrow({ where: { id: capturedRequest.id } })).status, "IN_PROGRESS");
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: capturedAttempt.id } }), 1);

  // If cancellation wins before a late capture, finalization creates no
  // booking and records explicit refund reconciliation instead.
  const lateRequest = await prisma.serviceRequest.create({ data: { seekerId: secondSeeker.id, categoryId: category.id, title: `Late capture ${suffix}`, description: "Capture arrives after cancellation", budgetMin: 500, budgetMax: 900, urgency: "medium" } });
  const lateOffer = await prisma.offer.create({ data: { requestId: lateRequest.id, providerId: provider.id, serviceId: requestRaceService.id, offeredPrice: 725, estimatedDuration: 60 } });
  await cancelRequest(lateRequest.id, secondSeeker.id);
  const lateAttempt = await prisma.paymentAttempt.create({ data: { idempotencyKey: `late-capture-${suffix}`, seekerId: secondSeeker.id, providerId: provider.id, serviceId: requestRaceService.id, offerId: lateOffer.id, providerIntentId: `pi_late_capture_${suffix}`, amount: 725, paymentMethod: "gcash", expiresAt: new Date(Date.now() + 60_000) } });
  const lateCapture = await finalizeSuccessfulPayment({ paymentIntentId: `pi_late_capture_${suffix}`, paymentId: `pay_late_capture_${suffix}`, amount: 725, currency: "PHP", metadata: { servicehub_attempt_id: lateAttempt.id, servicehub_seeker_id: secondSeeker.id, servicehub_service_id: requestRaceService.id, servicehub_offer_id: lateOffer.id, servicehub_expected_amount: "725.00", servicehub_payment_method: "gcash" } });
  assert.equal(lateCapture.refundRequired, true);
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: lateAttempt.id } }), 0);
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: lateAttempt.id } })).status, "REFUND_REQUIRED");

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
  await refundCapturedAttempt(capacityAttempt.id);
  await refundCapturedAttempt(capacityAttempt.id);
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: capacityAttempt.id } })).status, "REFUNDED");
  assert.equal(await prisma.paymentRefund.count({ where: { paymentAttemptId: capacityAttempt.id, status: "SIMULATED_TEST_MODE" } }), 1);

  const suspensionReport = await prisma.report.create({ data: { bookingId: capacityBlocker.id, reporterId: seeker.id, reportedUserId: provider.id, reason: "NO_SHOW", description: "Administrative suspension guard integration case." } });
  await assert.rejects(
    resolveAdminReport(suspensionReport.id, admin.id, "dismiss", "Temporary suspension requested by integration test.", "suspend"),
    /Resolve or administratively cancel/i,
  );
  assert.equal((await prisma.report.findUniqueOrThrow({ where: { id: suspensionReport.id } })).status, "UNDER_REVIEW");
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
  const repeatedAdminResolution = await resolveAdminReport(report.id, admin.id, "release_provider_and_complete", "Response was lost; return the established decision.");
  assert.deepEqual(repeatedAdminResolution, adminResolution);
  assert.equal(await prisma.adminAuditLog.count({ where: { actorId: admin.id, resourceId: report.id, action: "REPORT_RELEASE_PROVIDER_AND_COMPLETE" } }), 1);
});
