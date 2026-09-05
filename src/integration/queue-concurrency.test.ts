import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { markJobComplete } from "../services/bookings/completion.service";
import { providerStartJob } from "../services/bookings/provider-operations.service";
import { joinWaitlist } from "../services/bookings/waitlist.service";
import { requestCancellation } from "../services/cancellation.service";
import {
  createCompletionEscalation,
  resolveCompletionEscalation,
} from "../services/completion-escalation.service";
import { finalizeSuccessfulPayment } from "../services/payment-attempt.service";
import {
  lockServiceQueue,
  notifyWaitlist,
  recalculateQueue,
  recalculateQueueInTransaction,
} from "../services/queue.service";

type TestUser = Awaited<ReturnType<typeof prisma.user.create>>;

test("queue lifecycle and completion escalation remain correct under concurrency", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users: TestUser[] = [];
  let categoryId = "";
  let escalationBookingId = "";

  t.after(async () => {
    const userIds = users.map((user) => user.id);
    if (escalationBookingId) {
      await prisma.notification.deleteMany({
        where: { link: `/admin/reports?booking=${escalationBookingId}` },
      });
    }
    if (userIds.length > 0) {
      await prisma.completionEscalation.deleteMany({ where: { requestedBy: { in: userIds } } });
      await prisma.adminAuditLog.deleteMany({
        where: { OR: [{ actorId: { in: userIds } }, { targetUserId: { in: userIds } }] },
      });
      await prisma.paymentRefund.deleteMany({ where: { requestedById: { in: userIds } } });
      await prisma.queueNotify.deleteMany({ where: { seekerId: { in: userIds } } });
      await prisma.queue.deleteMany({ where: { seekerId: { in: userIds } } });
      await prisma.booking.deleteMany({
        where: { OR: [{ seekerId: { in: userIds } }, { providerId: { in: userIds } }] },
      });
      await prisma.paymentAttempt.deleteMany({ where: { seekerId: { in: userIds } } });
      await prisma.service.deleteMany({ where: { providerId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (categoryId) await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.$disconnect();
  });

  const category = await prisma.category.create({ data: { name: `Concurrency ${suffix}` } });
  categoryId = category.id;
  const makeUser = async (label: string, role = "user") => {
    const user = await prisma.user.create({
      data: {
        name: `Concurrency ${label}`,
        email: `${label.toLowerCase()}-${suffix}@example.test`,
        passwordHash: "test-only",
        phone: `${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
        location: "Cordova, Cebu",
        role,
        emailVerified: true,
        verificationStatus: "APPROVED",
      },
    });
    users.push(user);
    return user;
  };

  const provider = await makeUser("Provider");
  const admin = await makeUser("Admin", "admin");
  const seekers = await Promise.all([
    makeUser("SeekerOne"),
    makeUser("SeekerTwo"),
    makeUser("SeekerThree"),
    makeUser("WaitlistSeeker"),
  ]);
  const service = await prisma.service.create({
    data: {
      providerId: provider.id,
      categoryId: category.id,
      title: `Concurrent Queue ${suffix}`,
      titleNormalized: `concurrent queue ${suffix}`.toLowerCase(),
      description: "Concurrency integration service",
      price: 900,
      priceType: "FIXED",
      serviceType: "ONE_TIME",
      estimatedDurationMins: 30,
      queueLimit: 3,
      paymentMethods: { cash: false, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true,
    },
  });

  const attempts = await Promise.all(seekers.slice(0, 3).map((seeker, index) =>
    prisma.paymentAttempt.create({
      data: {
        idempotencyKey: `concurrent-${index}-${suffix}`,
        seekerId: seeker.id,
        providerId: provider.id,
        serviceId: service.id,
        providerIntentId: `pi_concurrent_${index}_${suffix}`,
        amount: 900,
        paymentMethod: "gcash",
        expiresAt: new Date(Date.now() + 60_000),
      },
    }),
  ));
  const paymentPayload = (index: number) => ({
    paymentIntentId: `pi_concurrent_${index}_${suffix}`,
    paymentId: `pay_concurrent_${index}_${suffix}`,
    amount: 900,
    currency: "PHP",
    metadata: {
      servicehub_attempt_id: attempts[index].id,
      servicehub_seeker_id: seekers[index].id,
      servicehub_service_id: service.id,
      servicehub_offer_id: "",
      servicehub_expected_amount: "900.00",
      servicehub_payment_method: "gcash",
    },
  });

  const finalized = await Promise.all([0, 1, 2].map((index) => finalizeSuccessfulPayment(paymentPayload(index))));
  assert.equal(finalized.every((item) => item.created), true);
  const activeQueue = await prisma.queue.findMany({
    where: { serviceId: service.id, status: "WAITING" },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(activeQueue.map((entry) => entry.position), [1, 2, 3]);
  assert.equal(new Set(activeQueue.map((entry) => entry.position)).size, 3);

  const duplicateFinalizations = await Promise.all([
    finalizeSuccessfulPayment(paymentPayload(0)),
    finalizeSuccessfulPayment(paymentPayload(0)),
  ]);
  assert.equal(duplicateFinalizations.every((item) => item.created === false), true);
  assert.equal(await prisma.booking.count({ where: { paymentAttemptId: attempts[0].id } }), 1);

  const first = finalized.find((item) => item.queue?.position === 1)!;
  const second = finalized.find((item) => item.queue?.position === 2)!;
  const third = finalized.find((item) => item.queue?.position === 3)!;
  const starts = await Promise.allSettled([
    providerStartJob(first.booking!.id, provider.id),
    providerStartJob(second.booking!.id, provider.id),
  ]);
  assert.equal(starts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: first.booking!.id } })).status, "ONGOING");
  assert.equal(await prisma.booking.count({ where: { providerId: provider.id, status: "ONGOING" } }), 1);

  await Promise.all([
    markJobComplete(first.booking!.id, provider.id),
    markJobComplete(first.booking!.id, provider.id),
  ]);
  const afterCompletion = await prisma.queue.findMany({
    where: { serviceId: service.id, status: "WAITING" },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(afterCompletion.map((entry) => entry.position), [1, 2]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/payment_intents/${second.queue!.paymentId}`)) {
      return new Response(JSON.stringify({
        data: {
          id: second.queue!.paymentId,
          attributes: {
            status: "succeeded",
            amount: 90_000,
            currency: "PHP",
            metadata: {},
            payments: [{ id: second.queue!.paymongoPaymentId }],
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/refunds") && init?.method === "POST") {
      return new Response(JSON.stringify({
        data: { id: `refund_concurrent_${suffix}`, attributes: { status: "succeeded" } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected mocked PayMongo request: ${url}`);
  }) as typeof fetch;
  try {
    const cancellationRace = await Promise.allSettled([
      requestCancellation(second.booking!.id, seekers[1].id, "Concurrent cancellation test."),
      recalculateQueue(service.id),
    ]);
    assert.equal(cancellationRace.some((result) => result.status === "fulfilled"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: second.booking!.id } })).status, "CANCELLED");
  assert.equal((await prisma.queue.findUniqueOrThrow({ where: { bookingId: third.booking!.id } })).position, 1);
  assert.equal(await prisma.paymentRefund.count({ where: { bookingId: second.booking!.id } }), 1);

  const waitlistService = await prisma.service.create({
    data: {
      providerId: provider.id,
      categoryId: category.id,
      title: `Waitlist Queue ${suffix}`,
      titleNormalized: `waitlist queue ${suffix}`.toLowerCase(),
      description: "Waitlist concurrency integration service",
      price: 500,
      priceType: "FIXED",
      serviceType: "ONE_TIME",
      estimatedDurationMins: 30,
      queueLimit: 1,
      paymentMethods: { cash: false, gcash: true, maya: false },
      status: "ACTIVE",
      isAvailable: true,
    },
  });
  const blocker = await prisma.booking.create({
    data: {
      seekerId: seekers[0].id,
      providerId: provider.id,
      serviceId: waitlistService.id,
      originType: "DIRECT_LISTING",
      paymentMethod: "GCash",
      agreedAmount: 500,
      paymentStatus: "PAID_HELD",
      status: "ACCEPTED",
      queuePosition: 1,
    },
  });
  const blockerQueue = await prisma.queue.create({
    data: {
      serviceId: waitlistService.id,
      seekerId: seekers[0].id,
      paymentId: `pi_waitlist_blocker_${suffix}`,
      paymentStatus: "PAID_HELD",
      position: 1,
      status: "WAITING",
      estimatedWait: 0,
      bookingId: blocker.id,
    },
  });
  const waitlistJoins = await Promise.allSettled([
    joinWaitlist(waitlistService.id, seekers[3].id),
    joinWaitlist(waitlistService.id, seekers[3].id),
  ]);
  assert.equal(waitlistJoins.filter((result) => result.status === "fulfilled").length, 1);
  await prisma.$transaction(async (tx) => {
    await lockServiceQueue(tx, waitlistService.id);
    await tx.booking.update({ where: { id: blocker.id }, data: { status: "CANCELED" } });
    await tx.queue.update({ where: { id: blockerQueue.id }, data: { status: "CANCELLED" } });
    await recalculateQueueInTransaction(tx, waitlistService.id);
  });
  await Promise.all([notifyWaitlist(waitlistService.id), notifyWaitlist(waitlistService.id)]);
  assert.equal(await prisma.queueNotify.count({ where: { serviceId: waitlistService.id } }), 0);
  assert.equal(await prisma.notification.count({
    where: { userId: seekers[3].id, title: "Queue slot available" },
  }), 1);

  escalationBookingId = first.booking!.id;
  await prisma.$executeRaw`UPDATE "bookings" SET "updatedAt" = NOW() - INTERVAL '71 hours' WHERE "id" = ${escalationBookingId}`;
  await assert.rejects(
    createCompletionEscalation(escalationBookingId, provider.id, "The seeker has not yet confirmed completion."),
    (error: any) => error?.code === "ESCALATION_WAIT_PERIOD",
  );
  await prisma.$executeRaw`UPDATE "bookings" SET "updatedAt" = NOW() - INTERVAL '73 hours' WHERE "id" = ${escalationBookingId}`;
  const duplicateEscalations = await Promise.all([
    createCompletionEscalation(escalationBookingId, provider.id, "The seeker has not confirmed the completed work."),
    createCompletionEscalation(escalationBookingId, provider.id, "Duplicate submission should return the active request."),
  ]);
  assert.equal(duplicateEscalations[0].id, duplicateEscalations[1].id);
  assert.equal(await prisma.completionEscalation.count({
    where: { bookingId: escalationBookingId, status: { in: ["PENDING", "UNDER_REVIEW"] } },
  }), 1);
  assert.equal(await prisma.notification.count({
    where: { userId: admin.id, link: `/admin/reports?booking=${escalationBookingId}` },
  }), 1);

  await resolveCompletionEscalation({
    escalationId: duplicateEscalations[0].id,
    adminId: admin.id,
    action: "keep_awaiting",
    resolution: "Keep awaiting the seeker while preserving the provider's escalation history.",
  });
  await assert.rejects(
    createCompletionEscalation(escalationBookingId, provider.id, "Trying again before the new 72-hour threshold."),
    (error: any) => error?.code === "ESCALATION_COOLDOWN" && /72 hours/i.test(error.message),
  );
  await prisma.completionEscalation.update({
    where: { id: duplicateEscalations[0].id },
    data: { resolvedAt: new Date(Date.now() - 73 * 60 * 60 * 1000) },
  });
  const secondEscalation = await createCompletionEscalation(
    escalationBookingId,
    provider.id,
    "The additional 72-hour waiting period has passed without confirmation.",
  );
  assert.notEqual(secondEscalation.id, duplicateEscalations[0].id);
});
