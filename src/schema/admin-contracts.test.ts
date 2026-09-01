import test from "node:test";
import assert from "node:assert/strict";
import {
  BooleanDecisionSchema,
  ReportResolutionSchema,
  SuspendUserSchema,
  TrustAdjustmentSchema,
  VerificationSubmissionSchema,
} from "./marketplace.schema";

test("moderation rejection requires a clear reason", () => {
  assert.equal(BooleanDecisionSchema.safeParse({ approve: false }).success, false);
  assert.equal(BooleanDecisionSchema.safeParse({ approve: false, adminNotes: "no" }).success, false);
  assert.equal(BooleanDecisionSchema.safeParse({ approve: false, adminNotes: "Address is outside Cordova." }).success, true);
  assert.equal(BooleanDecisionSchema.safeParse({ approve: true }).success, true);
});

test("report resolution always records an administrator rationale", () => {
  assert.equal(ReportResolutionSchema.safeParse({ action: "dismiss" }).success, false);
  assert.equal(ReportResolutionSchema.safeParse({ action: "approve_refund", adminNotes: "Evidence supports a full refund." }).success, true);
});

test("trust changes cannot be zero or anonymous", () => {
  assert.equal(TrustAdjustmentSchema.safeParse({ delta: 0, reason: "Manual review" }).success, false);
  assert.equal(TrustAdjustmentSchema.safeParse({ delta: -5, reason: "" }).success, false);
  assert.equal(TrustAdjustmentSchema.safeParse({ delta: -5, reason: "Confirmed policy violation" }).success, true);
});

test("temporary suspensions are bounded", () => {
  assert.equal(SuspendUserSchema.safeParse({ reason: "Repeated abuse", durationDays: 0 }).success, false);
  assert.equal(SuspendUserSchema.safeParse({ reason: "Repeated abuse", durationDays: 366 }).success, false);
  assert.equal(SuspendUserSchema.safeParse({ reason: "Repeated abuse", durationDays: 30 }).success, true);
});

test("verification accepts only private managed proof references and approved document types", () => {
  assert.equal(VerificationSubmissionSchema.safeParse({ proofs: [{ documentType: "GOVERNMENT_ID", storageKey: "https://example.com/id.jpg" }] }).success, false);
  assert.equal(VerificationSubmissionSchema.safeParse({ proofs: [{ documentType: "SKILL_CERTIFICATE", storageKey: "servicehub/verification/user123/id.jpg" }] }).success, false);
  assert.equal(VerificationSubmissionSchema.safeParse({ proofs: [{ documentType: "BARANGAY_ID", storageKey: "servicehub/verification/user123/id.jpg" }] }).success, true);
});
