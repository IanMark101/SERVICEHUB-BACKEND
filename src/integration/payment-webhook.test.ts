import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { receivePaymongoWebhook } from "../controllers/payments.controller";

test("a signed successful webhook is idempotent and creates one booking and queue row", async (t) => {
  const suffix = randomUUID();
  const provider = await prisma.user.create({
    data: {
      name: `Webhook Provider ${suffix}`,
      email: `provider-webhook-${suffix}@example.test`,
      passwordHash: "test-only-unusable-hash",
      phone: "test-only",
      location: "Cordova",
      emailVerified: true,
      verificationStatus: "APPROVED",
    },
  });
  const seeker = await prisma.user.create({
    data: {
      name: `Webhook Seeker ${suffix}`,
      email: `seeker-webhook-${suffix}@example.test`,
      passwordHash: "test-only-unusable-hash",
      phone: "test-only",
      location: "Cordova",
      emailVerified: true,
      verificationStatus: "APPROVED",
    },
  });
  const category = await prisma.category.create({ data: { name: `Webhook ${suffix}` } });
  const service = await prisma.service.create({
    data: {
      providerId: provider.id,
      categoryId: category.id,
      title: `Webhook Service ${suffix}`,
      titleNormalized: `webhook service ${suffix}`,
      description: "A sufficiently detailed service used for signed webhook integration testing.",
      price: 725,
      estimatedDurationMins: 60,
      queueLimit: 3,
      paymentMethods: { gcash: true },
      status: "ACTIVE",
      isAvailable: true,
    },
  });
  const attempt = await prisma.paymentAttempt.create({
    data: {
      idempotencyKey: `phase6-webhook-${suffix}`,
      seekerId: seeker.id,
      providerId: provider.id,
      serviceId: service.id,
      providerIntentId: `pi_phase6_${suffix}`,
      amount: 725,
      paymentMethod: "gcash",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const eventId = `evt_phase6_${suffix}`;

  t.after(async () => {
    await prisma.processedWebhookEvent.deleteMany({ where: { eventId } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: provider.id }, { userId: seeker.id }] } });
    await prisma.booking.deleteMany({ where: { paymentAttemptId: attempt.id } });
    await prisma.paymentAttempt.deleteMany({ where: { id: attempt.id } });
    await prisma.service.deleteMany({ where: { id: service.id } });
    await prisma.category.deleteMany({ where: { id: category.id } });
    await prisma.user.deleteMany({ where: { id: { in: [provider.id, seeker.id] } } });
    await prisma.$disconnect();
  });

  const payload = Buffer.from(JSON.stringify({
    data: {
      id: eventId,
      attributes: {
        type: "payment_intent.succeeded",
        data: { type: "payment_intent", id: `pi_phase6_${suffix}`, attributes: {} },
      },
    },
  }));
  const savedSecret = env.PAYMONGO_WEBHOOK_SECRET;
  const savedFetch = globalThis.fetch;
  env.PAYMONGO_WEBHOOK_SECRET = "whsk_phase6_local_replay_secret";
  globalThis.fetch = async (input) => {
    assert.match(String(input), new RegExp(`/payment_intents/pi_phase6_${suffix}$`));
    return new Response(JSON.stringify({
      data: {
        id: `pi_phase6_${suffix}`,
        attributes: {
          status: "succeeded",
          amount: 72_500,
          currency: "PHP",
          metadata: {
            servicehub_attempt_id: attempt.id,
            servicehub_seeker_id: seeker.id,
            servicehub_service_id: service.id,
            servicehub_offer_id: "",
            servicehub_expected_amount: "725.00",
            servicehub_payment_method: "gcash",
          },
          payments: [{ id: `pay_phase6_${suffix}` }],
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const signature = crypto.createHmac("sha256", env.PAYMONGO_WEBHOOK_SECRET).update(payload).digest("hex");
    const invoke = async () => {
      let statusCode = 200;
      let responseBody: any;
      let nextError: unknown;
      await receivePaymongoWebhook(
        { body: payload, get: () => signature } as any,
        { status(code: number) { statusCode = code; return this; }, json(body: any) { responseBody = body; return this; } } as any,
        (error) => { nextError = error; },
      );
      if (nextError) throw nextError;
      return { statusCode, responseBody };
    };

    assert.equal((await invoke()).statusCode, 200);
    const duplicate = await invoke();
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.responseBody.duplicate, true);
    assert.equal(await prisma.paymentAttempt.count({ where: { id: attempt.id, status: "SUCCEEDED" } }), 1);
    assert.equal(await prisma.booking.count({ where: { paymentAttemptId: attempt.id } }), 1);
    assert.equal(await prisma.queue.count({ where: { paymentId: `pi_phase6_${suffix}` } }), 1);
    assert.equal(await prisma.processedWebhookEvent.count({ where: { eventId, status: "PROCESSED" } }), 1);
  } finally {
    env.PAYMONGO_WEBHOOK_SECRET = savedSecret;
    globalThis.fetch = savedFetch;
  }
});
