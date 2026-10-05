import assert from "node:assert/strict";
import test from "node:test";
import { paidStartBlockReason } from "../services/bookings/paid-start-readiness";
import { CancellationResponseSchema } from "./marketplace.schema";

const ready = {
  bookingStatus: "ACCEPTED" as const,
  bookingStarted: false,
  bookingPaymentStatus: "PAID_HELD" as const,
  queueStatus: "WAITING" as const,
  queuePaymentStatus: "PAID_HELD" as const,
};

test("paid work can start only from the first valid captured booking state", () => {
  assert.equal(paidStartBlockReason(ready), null);
  assert.equal(paidStartBlockReason({ ...ready, bookingStatus: "WAITING" }), null);
  assert.match(paidStartBlockReason({ ...ready, bookingStatus: "UNDER_REVIEW" })!, /hold for review/i);
  assert.match(paidStartBlockReason({ ...ready, bookingPaymentStatus: "FROZEN_HELD" })!, /payment is not confirmed/i);
  assert.match(paidStartBlockReason({ ...ready, queuePaymentStatus: "FROZEN_HELD" })!, /payment is not confirmed/i);
  assert.match(paidStartBlockReason({ ...ready, queueStatus: "SERVING" })!, /no longer waiting/i);
  assert.match(paidStartBlockReason({ ...ready, bookingStarted: true })!, /already started/i);
});

test("declining a cancellation requires an explanation while approval does not", () => {
  assert.equal(CancellationResponseSchema.safeParse({ approve: true }).success, true);
  assert.equal(CancellationResponseSchema.safeParse({ approve: false }).success, false);
  assert.equal(CancellationResponseSchema.safeParse({ approve: false, responderNote: "  " }).success, false);
  assert.equal(CancellationResponseSchema.safeParse({ approve: false, responderNote: "Work has begun" }).success, true);
  assert.equal(CancellationResponseSchema.safeParse({ approve: false, providerNote: "Work has begun" }).success, true);
});
