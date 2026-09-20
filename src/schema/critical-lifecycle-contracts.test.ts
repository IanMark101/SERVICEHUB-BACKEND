import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("all existing-booking terminal mutations use the shared lifecycle lock", () => {
  const files = [
    "src/services/bookings/completion.service.ts",
    "src/services/bookings/provider-operations.service.ts",
    "src/services/bookings/direct-bookings.service.ts",
    "src/services/payment-refund.service.ts",
    "src/services/cancellation.service.ts",
    "src/services/safety-report.service.ts",
    "src/services/admin-report.service.ts",
  ];
  for (const file of files) {
    assert.match(source(file), /lockBookingLifecycle/, `${file} must use the common booking lifecycle lock`);
  }
  assert.doesNotMatch(source("src/services/bookings/completion.service.ts"), /pg_advisory_xact_lock[^\n]+completion:/);
  assert.doesNotMatch(source("src/services/cancellation.service.ts"), /pg_advisory_xact_lock[^\n]+booking-cancel:/);
});

test("report resolution requires a booking outcome separate from an optional penalty", () => {
  const schema = source("src/schema/marketplace.schema.ts");
  assert.match(schema, /outcome: z\.enum\(\["dismiss", "cancel_booking", "release_provider_and_complete"\]\)/);
  assert.match(schema, /penaltyAction: z\.enum\(\["none", "warn", "trust_deduct", "suspend", "ban"\]\)/);
  assert.doesNotMatch(schema, /action: z\.enum\(\["warn"/);
  assert.match(source("src/services/cancellation.service.ts"), /reportType: "CANCELLATION_ESCALATION"/);
});

test("cash and online Flow B selection share a request lock and database backstop", () => {
  const online = source("src/services/payment-attempt.service.ts");
  const cash = source("src/services/bookings/direct-bookings.service.ts");
  const migration = source("prisma/migrations/20260918143000_critical_lifecycle_invariants/migration.sql");
  assert.match(online, /request:\$\{targetOffer\.requestId\}/);
  assert.match(online, /request:\$\{initialOffer\.requestId\}/);
  assert.match(cash, /request:\$\{offer\.requestId\}/);
  assert.match(migration, /offers_one_selected_per_request_key/);
  assert.match(migration, /WHERE "status" IN \('PENDING_PAYMENT', 'ACCEPTED'\)/);
});

test("refund reserves the booking before the external effect and finalizes under the same lock", () => {
  const refund = source("src/services/payment-refund.service.ts");
  const firstLock = refund.indexOf("await lockBookingLifecycle(tx, bookingId)");
  const reservation = refund.indexOf('status: "PROCESSING"');
  const providerCall = refund.indexOf("await createRefund");
  const finalLock = refund.indexOf("await lockBookingLifecycle(tx, bookingId)", firstLock + 1);
  assert.ok(firstLock >= 0 && reservation > firstLock && providerCall > reservation && finalLock > providerCall);
  assert.match(refund, /completedService/);
  assert.match(refund, /Booking state changed before the refund could be finalized/);
});
