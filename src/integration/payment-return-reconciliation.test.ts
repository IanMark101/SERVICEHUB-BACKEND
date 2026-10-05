import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { reconcileOnlinePaymentReturn } from "../services/payment-attempt.service";

test("a GCash return independently verifies payment and creates one waiting booking per paid seeker", async (t) => {
  const suffix = randomUUID();
  const provider = await prisma.user.create({ data: {
    name: "Return Provider", email: `return-provider-${suffix}@example.test`, passwordHash: "test-only",
    phone: "test-only", location: "Cordova", emailVerified: true, verificationStatus: "APPROVED",
  } });
  const seekers = await Promise.all([0, 1].map(index => prisma.user.create({ data: {
    name: `Return Seeker ${index}`, email: `return-seeker-${index}-${suffix}@example.test`, passwordHash: "test-only",
    phone: "test-only", location: "Cordova", emailVerified: true, verificationStatus: "APPROVED",
  } })));
  const category = await prisma.category.create({ data: { name: `Return ${suffix}` } });
  const service = await prisma.service.create({ data: {
    providerId: provider.id, categoryId: category.id, title: `Return service ${suffix}`,
    titleNormalized: `return service ${suffix}`, description: "GCash return and queue regression fixture.",
    price: 70, estimatedDurationMins: 30, queueLimit: 3, paymentMethods: { gcash: true },
    status: "ACTIVE", isAvailable: true,
  } });
  const attempts = await Promise.all(seekers.map((seeker, index) => prisma.paymentAttempt.create({ data: {
    idempotencyKey: `return-${index}-${suffix}`, seekerId: seeker.id, providerId: provider.id,
    serviceId: service.id, providerIntentId: `pi_return_${index}_${suffix}`, amount: 70,
    paymentMethod: "gcash", expiresAt: new Date(Date.now() + 120_000),
  } })));
  const savedFetch = globalThis.fetch;
  const succeeded = new Set<string>();
  globalThis.fetch = async (input) => {
    const intentId = String(input).split("/").at(-1)!;
    const index = attempts.findIndex(attempt => attempt.providerIntentId === intentId);
    assert.notEqual(index, -1, "only an owned, registered intent may be queried");
    const attempt = attempts[index];
    return new Response(JSON.stringify({ data: { id: intentId, attributes: {
      status: succeeded.has(intentId) ? "succeeded" : "awaiting_next_action",
      amount: 7000, currency: "PHP", payments: [{ id: `pay_return_${index}_${suffix}` }],
      metadata: {
        servicehub_attempt_id: attempt.id, servicehub_seeker_id: attempt.seekerId,
        servicehub_service_id: service.id, servicehub_offer_id: "",
        servicehub_expected_amount: "70.00", servicehub_payment_method: "gcash",
      },
    } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(async () => {
    globalThis.fetch = savedFetch;
    await prisma.notification.deleteMany({ where: { userId: { in: [provider.id, ...seekers.map(seeker => seeker.id)] } } });
    await prisma.queue.deleteMany({ where: { serviceId: service.id } });
    await prisma.booking.deleteMany({ where: { serviceId: service.id } });
    await prisma.paymentAttempt.deleteMany({ where: { id: { in: attempts.map(attempt => attempt.id) } } });
    await prisma.service.delete({ where: { id: service.id } });
    await prisma.category.delete({ where: { id: category.id } });
    await prisma.user.deleteMany({ where: { id: { in: [provider.id, ...seekers.map(seeker => seeker.id)] } } });
    await prisma.$disconnect();
  });

  await assert.rejects(reconcileOnlinePaymentReturn(seekers[1].id, attempts[0].providerIntentId!), /not found/i);
  assert.equal((await reconcileOnlinePaymentReturn(seekers[0].id, attempts[0].providerIntentId!)).status, "PENDING");
  assert.equal(await prisma.booking.count({ where: { serviceId: service.id } }), 0);

  succeeded.add(attempts[0].providerIntentId!);
  assert.equal((await reconcileOnlinePaymentReturn(seekers[0].id, attempts[0].providerIntentId!)).status, "SUCCEEDED");
  const first = await prisma.booking.findUniqueOrThrow({ where: { paymentAttemptId: attempts[0].id }, include: { queue: true } });
  assert.equal(first.status, "ACCEPTED");
  assert.equal(first.paymentStatus, "PAID_HELD");
  assert.equal(first.started, false);
  assert.equal(first.queue?.status, "WAITING");
  assert.equal(first.queue?.position, 1);

  succeeded.add(attempts[1].providerIntentId!);
  assert.equal((await reconcileOnlinePaymentReturn(seekers[1].id, attempts[1].providerIntentId!)).status, "SUCCEEDED");
  const second = await prisma.booking.findUniqueOrThrow({ where: { paymentAttemptId: attempts[1].id }, include: { queue: true } });
  assert.equal(second.queue?.status, "WAITING");
  assert.equal(second.queue?.position, 2);
  assert.equal((await reconcileOnlinePaymentReturn(seekers[0].id, attempts[0].providerIntentId!)).status, "SUCCEEDED");
  assert.equal(await prisma.booking.count({ where: { serviceId: service.id } }), 2);
  assert.equal(await prisma.queue.count({ where: { serviceId: service.id, status: "WAITING" } }), 2);
});
