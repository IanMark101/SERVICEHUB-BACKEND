import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { requireAdmin, requireEmailVerified, requireVerification } from "../middlewares/auth.middleware";
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
