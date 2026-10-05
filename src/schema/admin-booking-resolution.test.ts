import assert from "node:assert/strict";
import test from "node:test";
import { adminBookingOutcomeAllowed } from "../services/admin-booking-resolution.service";

test("an unstarted booking can be administratively cancelled without a ban", () => {
  for (const status of ["PENDING_APPROVAL", "WAITING", "ACCEPTED"]) {
    assert.equal(adminBookingOutcomeAllowed({ status, started: false, paymentMethod: "On-site Cash" }, false, "cancel_booking"), true);
    assert.equal(adminBookingOutcomeAllowed({ status, started: true, paymentMethod: "On-site Cash" }, false, "cancel_booking"), false);
  }
});

test("a banned participant's active booking can be cancelled, but only an online completed job can be released", () => {
  const booking = (status: string, paymentMethod = "GCash") => ({ status, started: true, paymentMethod });
  assert.equal(adminBookingOutcomeAllowed(booking("ONGOING"), true, "cancel_booking"), true);
  assert.equal(adminBookingOutcomeAllowed(booking("ONGOING"), true, "release_provider_and_complete"), false);
  assert.equal(adminBookingOutcomeAllowed(booking("AWAITING_CONFIRMATION"), true, "cancel_booking"), true);
  assert.equal(adminBookingOutcomeAllowed(booking("AWAITING_CONFIRMATION"), true, "release_provider_and_complete"), true);
  assert.equal(adminBookingOutcomeAllowed(booking("AWAITING_CONFIRMATION", "On-site Cash"), true, "release_provider_and_complete"), false);
  assert.equal(adminBookingOutcomeAllowed(booking("AWAITING_CONFIRMATION"), false, "release_provider_and_complete"), false);
  assert.equal(adminBookingOutcomeAllowed(booking("DISPUTED"), true, "cancel_booking"), false);
});
