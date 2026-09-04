import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OfferSchema, ReportResolutionSchema } from "./marketplace.schema";

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

test("online initiation derives price from the service and requires one-time fixed pricing", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/services/payment-attempt.service.ts"), "utf8");
  const initiationContract = source.match(/initiateOnlinePayment\(params: \{[\s\S]*?\n\}\) \{/);
  assert.ok(initiationContract, "initiateOnlinePayment input contract should be present");
  assert.match(source, /PAYMENT_NOT_CONFIGURED/);
  assert.match(source, /price: true/);
  assert.match(source, /Number\(service\.price\)/);
  assert.match(source, /!params\.offerId && service\.priceType !== "FIXED"/);
  assert.match(source, /service\.serviceType !== "ONE_TIME"/);
  assert.doesNotMatch(initiationContract[0], /amount\s*:/);
});

test("advanced pricing requires an exact offer and unfinished session booking stays disabled", () => {
  const directSource = fs.readFileSync(path.join(process.cwd(), "src/services/bookings/direct-bookings.service.ts"), "utf8");
  assert.match(directSource, /service\.priceType !== "FIXED"/);
  assert.match(directSource, /service\.serviceType !== "ONE_TIME"/);
  assert.match(directSource, /agreedAmount: offer\.offeredPrice/);
  assert.match(directSource, /SESSION_SCHEDULING_NOT_AVAILABLE/);
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
  process.env.PAYMONGO_WEBHOOK_SECRET = "whsk_test_signature_secret_123456";
  const { validPaymongoSignature } = await import("../controllers/payments.controller");
  const body = Buffer.from('{"data":{"id":"evt_test"}}', "utf8");
  const signature = crypto.createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET).update(body).digest("hex");
  assert.equal(validPaymongoSignature(body, signature), true);
  assert.equal(validPaymongoSignature(Buffer.from(`${body.toString("utf8")} `), signature), false);
  assert.equal(validPaymongoSignature(body, "not-a-signature"), false);
});
