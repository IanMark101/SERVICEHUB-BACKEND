import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { VERIFICATION_PRIVACY_NOTICE_VERSION } from "../config/privacy";
import { requireVerification } from "../middlewares/auth.middleware";
import { submitVerification } from "../services/verification.service";
import { createDirectRequest, respondToDirectBookingService } from "../services/bookings/direct-bookings.service";
import { providerStartJob } from "../services/bookings/provider-operations.service";
import { disputeJobService } from "../services/bookings/completion.service";
import {
  escalateCancellationRequest,
  requestCancellation,
  respondToCancellationRequest,
} from "../services/cancellation.service";
import { requestAccountDeletion } from "../services/account-deletion.service";

function invokeGuard(user: Record<string, unknown>) {
  let status = 200;
  let body: any;
  let nextCalled = false;
  requireVerification(
    { user } as any,
    { status(code: number) { status = code; return this; }, json(value: any) { body = value; return this; } } as any,
    () => { nextCalled = true; },
  );
  return { status, body, nextCalled };
}

test("email, moderation, existing-resolution, cancellation, and duplicate-dispute safeguards", async (t) => {
  const suffix = randomUUID();
  const users: string[] = [];
  const makeUser = async (label: string, overrides: Record<string, unknown> = {}) => {
    const user = await prisma.user.create({
      data: {
        name: `${label} ${suffix}`,
        email: `${label.toLowerCase()}-${suffix}@example.test`,
        passwordHash: "test-only-unusable-hash",
        phone: `test-${label}`,
        location: "Cordova",
        emailVerified: true,
        verificationStatus: "APPROVED",
        ...overrides,
      },
    });
    users.push(user.id);
    return user;
  };

  const unverified = await makeUser("Unverified", { emailVerified: false, verificationStatus: "UNVERIFIED" });
  const seeker = await makeUser("Seeker");
  const provider = await makeUser("Provider");
  const category = await prisma.category.create({ data: { name: `Phase 7 ${suffix}` } });
  const service = await prisma.service.create({
    data: {
      providerId: provider.id,
      categoryId: category.id,
      title: `Phase 7 Service ${suffix}`,
      titleNormalized: `phase 7 service ${suffix}`,
      description: "A detailed service fixture for authorization and lifecycle integration tests.",
      price: 500,
      estimatedDurationMins: 45,
      queueLimit: 1,
      paymentMethods: { cash: true, gcash: true },
      status: "ACTIVE",
      isAvailable: true,
    },
  });

  t.after(async () => {
    await prisma.completionEscalation.deleteMany({ where: { requestedBy: { in: users } } });
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actorId: { in: users } }, { targetUserId: { in: users } }] } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: users } }, { reportedUserId: { in: users } }] } });
    await prisma.cancellationRequest.deleteMany({ where: { booking: { OR: [{ seekerId: { in: users } }, { providerId: { in: users } }] } } });
    await prisma.message.deleteMany({ where: { OR: [{ senderId: { in: users } }, { receiverId: { in: users } }] } });
    await prisma.paymentRefund.deleteMany({ where: { requestedById: { in: users } } });
    await prisma.queue.deleteMany({ where: { seekerId: { in: users } } });
    await prisma.completedService.deleteMany({ where: { OR: [{ seekerId: { in: users } }, { providerId: { in: users } }] } });
    await prisma.booking.deleteMany({ where: { OR: [{ seekerId: { in: users } }, { providerId: { in: users } }] } });
    await prisma.paymentAttempt.deleteMany({ where: { seekerId: { in: users } } });
    await prisma.directRequest.deleteMany({ where: { OR: [{ seekerId: { in: users } }, { providerId: { in: users } }] } });
    await prisma.serviceRequest.deleteMany({ where: { seekerId: { in: users } } });
    await prisma.accountDeletionRequest.deleteMany({ where: { userId: { in: users } } });
    await prisma.serviceVerification.deleteMany({ where: { userId: { in: users } } });
    await prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await prisma.service.deleteMany({ where: { providerId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.category.deleteMany({ where: { id: category.id } });
    await prisma.$disconnect();
  });

  await assert.rejects(
    submitVerification(
      unverified.id,
      [{ storageKey: `servicehub/verification/${unverified.id}/id.jpg`, documentType: "GOVERNMENT_ID" }],
      VERIFICATION_PRIVACY_NOTICE_VERSION,
      true,
    ),
    (error: any) => error?.status === 403 && error?.code === "EMAIL_NOT_VERIFIED",
  );
  const unverifiedGate = invokeGuard({
    role: "user", isActive: true, moderationStatus: "ACTIVE",
    emailVerified: false, verificationStatus: "APPROVED",
  });
  assert.equal(unverifiedGate.status, 403);
  assert.equal(unverifiedGate.body.code, "EMAIL_NOT_VERIFIED");
  const suspendedGate = invokeGuard({
    role: "user", isActive: true, moderationStatus: "SUSPENDED",
    emailVerified: true, verificationStatus: "APPROVED",
  });
  assert.equal(suspendedGate.status, 403);
  assert.equal(suspendedGate.nextCalled, false);

  const pending = await createDirectRequest({ seekerId: seeker.id, providerId: provider.id, serviceId: service.id });
  await prisma.user.update({ where: { id: provider.id }, data: { moderationStatus: "SUSPENDED", suspendedUntil: new Date(Date.now() + 86_400_000) } });
  await assert.rejects(
    respondToDirectBookingService(pending.id, provider.id, true),
    (error: any) => error?.status === 403 && error?.code === "ACCEPT_BOOKING_NOT_ALLOWED",
  );
  const declined = await respondToDirectBookingService(pending.id, provider.id, false);
  assert.equal(declined.status, "DECLINED");

  const accepted = await prisma.booking.create({
    data: { seekerId: seeker.id, providerId: provider.id, serviceId: service.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 500, paymentStatus: "UNPAID", status: "ACCEPTED" },
  });
  await assert.rejects(
    providerStartJob(accepted.id, provider.id),
    (error: any) => error?.status === 403 && error?.code === "START_JOB_NOT_ALLOWED",
  );

  const makeOngoing = () => prisma.booking.create({
    data: { seekerId: seeker.id, providerId: provider.id, serviceId: service.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 500, paymentStatus: "UNPAID", status: "ONGOING", started: true },
  });
  const seekerApprovedBooking = await makeOngoing();
  const seekerRequest = await requestCancellation(seekerApprovedBooking.id, seeker.id, "Seeker requests cancellation after work started.");
  await respondToCancellationRequest(seekerRequest.request.id, provider.id, true, "Provider approves the request.");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: seekerApprovedBooking.id } })).status, "CANCELED");

  const providerApprovedBooking = await makeOngoing();
  const providerRequest = await requestCancellation(providerApprovedBooking.id, provider.id, "Provider requests cancellation after work started.");
  await respondToCancellationRequest(providerRequest.request.id, seeker.id, true, "Seeker approves the request.");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: providerApprovedBooking.id } })).status, "CANCELED");

  const seekerEscalatedBooking = await makeOngoing();
  const seekerDeclined = await requestCancellation(seekerEscalatedBooking.id, seeker.id, "Seeker cancellation requires administrator review.");
  await respondToCancellationRequest(seekerDeclined.request.id, provider.id, false, "Provider declines.");
  await escalateCancellationRequest(seekerDeclined.request.id, seeker.id);
  assert.equal((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: seekerDeclined.request.id } })).status, "ESCALATED");
  await prisma.booking.update({ where: { id: seekerEscalatedBooking.id }, data: { status: "DISPUTED" } });

  const providerEscalatedBooking = await makeOngoing();
  const providerDeclined = await requestCancellation(providerEscalatedBooking.id, provider.id, "Provider cancellation requires administrator review.");
  await respondToCancellationRequest(providerDeclined.request.id, seeker.id, false, "Seeker declines.");
  await escalateCancellationRequest(providerDeclined.request.id, provider.id);
  assert.equal((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: providerDeclined.request.id } })).status, "ESCALATED");
  assert.equal(await prisma.report.count({ where: { reportType: "CANCELLATION_ESCALATION", bookingId: { in: [seekerEscalatedBooking.id, providerEscalatedBooking.id] } } }), 2);

  const awaiting = await prisma.booking.create({
    data: { seekerId: seeker.id, providerId: provider.id, serviceId: service.id, originType: "DIRECT_LISTING", paymentMethod: "On-site Cash", agreedAmount: 500, paymentStatus: "UNPAID", status: "AWAITING_CONFIRMATION", started: true },
  });
  await disputeJobService(awaiting.id, seeker.id, "INCOMPLETE_SERVICE", "The work requires administrator review.");
  await assert.rejects(
    disputeJobService(awaiting.id, seeker.id, "INCOMPLETE_SERVICE", "Duplicate dispute."),
    (error: any) => error?.status === 409 && error?.code === "DUPLICATE_DISPUTE",
  );

  const savedFetch = globalThis.fetch;
  const savedKey = env.PAYMONGO_SECRET_KEY;
  env.PAYMONGO_SECRET_KEY = "sk_test_phase7";
  globalThis.fetch = async (input) => {
    const intentId = String(input).split("/").pop();
    return new Response(JSON.stringify({ data: { id: intentId, attributes: { status: "succeeded", amount: 50_000, currency: "PHP", metadata: {}, payments: [{ id: `pay_${intentId}` }] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const makeHeld = async (paymentId: string) => {
      const booking = await prisma.booking.create({
        data: { seekerId: seeker.id, providerId: provider.id, serviceId: service.id, originType: "DIRECT_LISTING", paymentMethod: "GCash", agreedAmount: 500, paymentStatus: "PAID_HELD", status: "ACCEPTED" },
      });
      await prisma.queue.create({ data: { serviceId: service.id, seekerId: seeker.id, paymentId, paymongoPaymentId: `pay_${paymentId}`, paymentStatus: "PAID_HELD", position: 1, status: "WAITING", estimatedWait: 0, bookingId: booking.id } });
      return booking;
    };
    const suspendedHeld = await makeHeld(`pi_suspended_${suffix}`);
    await requestCancellation(suspendedHeld.id, provider.id, "Suspended provider resolves an existing held booking.");
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: suspendedHeld.id } })).paymentStatus, "REFUNDED");

    await prisma.user.update({ where: { id: provider.id }, data: { moderationStatus: "BANNED", suspendedUntil: null } });
    const bannedHeld = await makeHeld(`pi_banned_${suffix}`);
    await requestCancellation(bannedHeld.id, provider.id, "Banned provider resolves an existing held booking.");
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bannedHeld.id } })).paymentStatus, "REFUNDED");

    const deletionBlocker = await makeHeld(`pi_deletion_${suffix}`);
    const deletion = await requestAccountDeletion(seeker.id);
    assert.equal(deletion.status, "BLOCKED");
    assert.equal((deletion.blockers as any[]).some((item) => item.type === "heldPayments"), true);
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: deletionBlocker.id } })).paymentStatus, "PAID_HELD");
  } finally {
    globalThis.fetch = savedFetch;
    env.PAYMONGO_SECRET_KEY = savedKey;
  }
});
