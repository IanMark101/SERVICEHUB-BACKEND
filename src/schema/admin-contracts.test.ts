import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { accountAccessDecision, requireAdmin, requireEmailVerified, requireVerification } from "../middlewares/auth.middleware";
import {
  AdminCategoryUpdateSchema,
  AdminCancellationDecisionSchema,
  BooleanDecisionSchema,
  ReportResolutionSchema,
  RestoreUserSchema,
  SuspendUserSchema,
  TrustAdjustmentSchema,
  VerificationSubmissionSchema,
} from "./marketplace.schema";
import { VERIFICATION_PRIVACY_NOTICE_VERSION } from "../config/privacy";

test("moderation rejection requires a clear reason", () => {
  assert.equal(BooleanDecisionSchema.safeParse({ approve: false }).success, false);
  assert.equal(BooleanDecisionSchema.safeParse({ approve: false, adminNotes: "no" }).success, false);
  assert.equal(BooleanDecisionSchema.safeParse({ approve: false, adminNotes: "Address is outside Cordova." }).success, true);
  assert.equal(BooleanDecisionSchema.safeParse({ approve: true }).success, true);
});

test("category management requires an explicit change and audit reason", () => {
  assert.equal(AdminCategoryUpdateSchema.safeParse({ name: "Plumbing", reason: "Correct marketplace label" }).success, true);
  assert.equal(AdminCategoryUpdateSchema.safeParse({ isActive: false, reason: "Retire unused category" }).success, true);
  assert.equal(AdminCategoryUpdateSchema.safeParse({ name: "Plumbing" }).success, false);
  assert.equal(AdminCategoryUpdateSchema.safeParse({ reason: "No actual change" }).success, false);
});

test("report resolution always records an administrator rationale", () => {
  assert.equal(ReportResolutionSchema.safeParse({ outcome: "dismiss" }).success, false);
  assert.equal(ReportResolutionSchema.safeParse({ outcome: "cancel_booking", penaltyAction: "trust_deduct", adminNotes: "Evidence supports cancellation." }).success, true);
  assert.equal(ReportResolutionSchema.safeParse({ outcome: "trust_deduct", adminNotes: "Penalty without outcome." }).success, false);
});

test("trust changes cannot be zero or anonymous", () => {
  assert.equal(TrustAdjustmentSchema.safeParse({ delta: 0, reason: "Manual review" }).success, false);
  assert.equal(TrustAdjustmentSchema.safeParse({ delta: -5, reason: "" }).success, false);
  assert.equal(TrustAdjustmentSchema.safeParse({ delta: -5, reason: "Confirmed policy violation" }).success, false);
  assert.equal(TrustAdjustmentSchema.safeParse({ delta: -5, reason: "Confirmed policy violation", currentPassword: "current-secret", operationId: "a40cd2da-685e-44a2-bef2-42f1aa0c198f" }).success, true);
});

test("cancellation fault findings require a reason, an approval and one valid participant role", () => {
  assert.equal(AdminCancellationDecisionSchema.safeParse({ approve: true, fault: 'provider' }).success, false);
  assert.equal(AdminCancellationDecisionSchema.safeParse({ approve: true, adminNotes: 'Supported fault finding', fault: 'provider' }).success, true);
  assert.equal(AdminCancellationDecisionSchema.safeParse({ approve: true, adminNotes: 'Mutual cancellation', fault: 'none' }).success, true);
  assert.equal(AdminCancellationDecisionSchema.safeParse({ approve: false, adminNotes: 'Cancellation denied', fault: 'seeker' }).success, false);
  assert.equal(AdminCancellationDecisionSchema.safeParse({ approve: true, adminNotes: 'Invalid target', fault: 'both' }).success, false);
});

test("temporary suspensions are bounded", () => {
  assert.equal(SuspendUserSchema.safeParse({ reason: "Repeated abuse", durationDays: 0 }).success, false);
  assert.equal(SuspendUserSchema.safeParse({ reason: "Repeated abuse", durationDays: 366 }).success, false);
  assert.equal(SuspendUserSchema.safeParse({ reason: "Repeated abuse", durationDays: 30 }).success, true);
});

test("restoring or unbanning requires an administrator reason", () => {
  assert.equal(RestoreUserSchema.safeParse({}).success, false);
  assert.equal(RestoreUserSchema.safeParse({ reason: "Reviewed and approved" }).success, true);
});

test("banned accounts retain appeal identity but never normal API access even with isActive=true", () => {
  for (const isActive of [true, false]) {
    assert.equal(accountAccessDecision({ isActive, moderationStatus: "BANNED" }), "ACCOUNT_BANNED");
    assert.equal(accountAccessDecision({ isActive, moderationStatus: "BANNED" }, true), "ALLOW");
  }
  assert.equal(accountAccessDecision({ isActive: true, moderationStatus: "SUSPENDED" }), "ALLOW");
  assert.equal(accountAccessDecision({ isActive: false, moderationStatus: "ACTIVE" }), "ACCOUNT_INACTIVE");
  assert.equal(accountAccessDecision({ isActive: false, moderationStatus: "BANNED", deactivatedAt: new Date() }, true), "ACCOUNT_INACTIVE");
});

test("verification accepts only private managed proof references and approved document types", () => {
  const consent = { privacyNoticeVersion: VERIFICATION_PRIVACY_NOTICE_VERSION, privacyAcknowledged: true };
  assert.equal(VerificationSubmissionSchema.safeParse({ ...consent, proofs: [{ documentType: "GOVERNMENT_ID", storageKey: "https://example.com/id.jpg" }] }).success, false);
  assert.equal(VerificationSubmissionSchema.safeParse({ ...consent, proofs: [{ documentType: "SKILL_CERTIFICATE", storageKey: "servicehub/verification/user123/id.jpg" }] }).success, false);
  assert.equal(VerificationSubmissionSchema.safeParse({ ...consent, proofs: [{ documentType: "BARANGAY_ID", storageKey: "servicehub/verification/user123/id.jpg" }] }).success, true);
  assert.equal(VerificationSubmissionSchema.safeParse({ proofs: [{ documentType: "BARANGAY_ID", storageKey: "servicehub/verification/user123/id.jpg" }] }).success, false);
});

test("a standard user receives 403 from the administrator role guard", () => {
  const req = { user: { id: "user-1", role: "user" } } as unknown as Request;
  let statusCode = 0;
  let responseBody: unknown;
  let nextCalled = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as unknown as Response;
  const next = (() => {
    nextCalled = true;
  }) as NextFunction;

  requireAdmin(req, res, next);

  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
  assert.deepEqual(responseBody, { success: false, error: "Admin access required" });
});

test("marketplace actions require both email and approved residency", () => {
  const invoke = (guard: typeof requireEmailVerified, user: Record<string, unknown>) => {
    let statusCode = 0;
    let responseBody: any;
    let nextCalled = false;
    const req = { user } as unknown as Request;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        return this;
      },
    } as unknown as Response;
    guard(req, res, (() => { nextCalled = true; }) as NextFunction);
    return { statusCode, responseBody, nextCalled };
  };

  const unverifiedEmail = invoke(requireEmailVerified, { emailVerified: false });
  assert.equal(unverifiedEmail.statusCode, 403);
  assert.equal(unverifiedEmail.responseBody.code, "EMAIL_NOT_VERIFIED");

  const unverifiedResident = invoke(requireVerification, {
    role: "user",
    isActive: true,
    moderationStatus: "ACTIVE",
    emailVerified: true,
    verificationStatus: "UNVERIFIED",
  });
  assert.equal(unverifiedResident.statusCode, 403);
  assert.equal(unverifiedResident.responseBody.code, "VERIFICATION_REQUIRED");

  const eligible = invoke(requireVerification, {
    role: "user",
    isActive: true,
    moderationStatus: "ACTIVE",
    emailVerified: true,
    verificationStatus: "APPROVED",
  });
  assert.equal(eligible.nextCalled, true);
});
