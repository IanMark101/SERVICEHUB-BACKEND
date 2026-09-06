import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OfferSchema, ReportResolutionSchema } from "./marketplace.schema";
import { env, validateEnvironment } from "../config/env";
import { createRefund } from "../services/paymongo.service";
import { CreateServiceSchema, UpdateServiceSchema } from "./services.schema";

test("production configuration reports each missing PayMongo field", () => {
  const parsed = validateEnvironment({
    DATABASE_URL: "postgresql://test.invalid/servicehub",
    JWT_ACCESS_SECRET: "test-access-secret-long-enough",
    JWT_REFRESH_SECRET: "test-refresh-secret-long-enough",
    NODE_ENV: "production",
  });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const fields = parsed.error.flatten().fieldErrors;
  assert.deepEqual(Object.keys(fields).sort(), [
    "PAYMONGO_PUBLIC_KEY",
    "PAYMONGO_SECRET_KEY",
    "PAYMONGO_WEBHOOK_SECRET",
  ]);
});

test("Test Mode refund is an explicit internal reversal and never calls the provider refund API", async () => {
  const savedKey = env.PAYMONGO_SECRET_KEY;
  const savedFetch = globalThis.fetch;
  env.PAYMONGO_SECRET_KEY = "sk_test_contract_only";
  globalThis.fetch = async () => { throw new Error("Test Mode refund must not call PayMongo"); };
  try {
    const result = await createRefund({ paymentId: "pay_test_contract", reason: "others", idempotencyKey: "refund-contract" });
    assert.equal(result.status, "simulated_test_mode");
    assert.match(result.id, /^internal_test_refund_/);
  } finally {
    env.PAYMONGO_SECRET_KEY = savedKey;
    globalThis.fetch = savedFetch;
  }
});

test("Flow B offers require an exact provider listing", () => {
  const base = {
    requestId: "cm12345678901234567890123",
    offeredPrice: 500,
    estimatedDuration: 60,
  };
  assert.equal(OfferSchema.safeParse(base).success, false);
  assert.equal(OfferSchema.safeParse({ ...base, serviceId: "cm22345678901234567890123" }).success, true);
});

test("administrator can explicitly release a disputed provider payment", () => {
  assert.equal(ReportResolutionSchema.safeParse({
    action: "release_provider_and_complete",
    adminNotes: "Message history and completion evidence support the provider.",
  }).success, true);
});

test("browser payment return is status-only, never booking fulfillment", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/controllers/bookings/payment-v2.controller.ts"), "utf8");
  assert.doesNotMatch(source, /getPaymentIntent|addToQueue|booking\.create|queue\.create/);
  assert.match(source, /getPaymentAttemptStatus/);
});

test("online initiation derives its fixed listing price", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/services/payment-attempt.service.ts"), "utf8");
  const initiationContract = source.match(/initiateOnlinePayment\(params: \{[\s\S]*?\n\}\) \{/);
  assert.ok(initiationContract, "initiateOnlinePayment input contract should be present");
  assert.match(source, /PAYMENT_NOT_CONFIGURED/);
  assert.match(source, /price: true/);
  assert.match(source, /Number\(service\.price\)/);
  assert.match(source, /!params\.offerId && !\["FIXED", "PER_SESSION"\]\.includes\(service\.priceType\)/);
  assert.doesNotMatch(initiationContract[0], /amount\s*:/);
});

test("new listings are reusable one-time engagements and advanced pricing requires an exact offer", () => {
  const directSource = fs.readFileSync(path.join(process.cwd(), "src/services/bookings/direct-bookings.service.ts"), "utf8");
  assert.match(directSource, /agreedAmount: offer\.offeredPrice/);
  assert.doesNotMatch(directSource, /SESSION_SCHEDULING_NOT_AVAILABLE/);
  const base = {
    categoryId: "category-id",
    title: "Mathematics tutoring",
    description: "Individual tutoring requested as a reusable one-time engagement.",
    price: 500,
    estimatedDurationMins: 60,
    queueLimit: 3,
    paymentMethods: { cash: true },
  };
  assert.equal(CreateServiceSchema.safeParse({ ...base, serviceType: "ONE_TIME" }).success, true);
  assert.equal(CreateServiceSchema.safeParse({ ...base, serviceType: "SESSION_BASED" }).success, false);
  assert.equal(CreateServiceSchema.safeParse({ ...base, priceType: "PER_SESSION" }).success, false);
  assert.equal(UpdateServiceSchema.safeParse({ serviceType: "SESSION_BASED" }).success, false);
  assert.match(directSource, /status: \{\s*in: \["PENDING_APPROVAL", "WAITING", "ONGOING", "ACCEPTED", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED"\]/);
  assert.doesNotMatch(directSource, /status: \{\s*in: \[[^\]]*"COMPLETED"/);
});

test("queue start and completion retain the global and idempotency guards", () => {
  const startSource = fs.readFileSync(path.join(process.cwd(), "src/services/bookings/provider-operations.service.ts"), "utf8");
  const completionSource = fs.readFileSync(path.join(process.cwd(), "src/services/bookings/completion.service.ts"), "utf8");
  assert.match(startSource, /provider-start:/);
  assert.match(startSource, /otherOngoing/);
  assert.match(completionSource, /booking-completion:/);
  assert.match(completionSource, /CASH_CONFIRMED/);
  assert.match(completionSource, /ONLINE_LEDGER/);
});

test("PayMongo webhook signature covers the unmodified raw body", async () => {
  const savedSecret = env.PAYMONGO_WEBHOOK_SECRET;
  env.PAYMONGO_WEBHOOK_SECRET = "whsk_test_signature_secret_123456";
  const { validPaymongoSignature } = await import("../controllers/payments.controller");
  const body = Buffer.from('{"data":{"id":"evt_test"}}', "utf8");
  try {
    const signature = crypto.createHmac("sha256", env.PAYMONGO_WEBHOOK_SECRET).update(body).digest("hex");
    assert.equal(validPaymongoSignature(body, signature), true);
    assert.equal(validPaymongoSignature(Buffer.from(`${body.toString("utf8")} `), signature), false);
    assert.equal(validPaymongoSignature(body, "not-a-signature"), false);
  } finally {
    env.PAYMONGO_WEBHOOK_SECRET = savedSecret;
  }
});
