import test from "node:test";
import assert from "node:assert/strict";
import { allowedReportOutcomes, assertReportDecision } from "../services/report-decision-policy";
import { CaseQuerySchema } from "../controllers/admin/case-workspace.controller";
import { ReportResolutionSchema } from "./marketplace.schema";
import { prisma } from "../lib/prisma";
import { resolveAdminReport } from "../services/admin-report.service";

const safety = { reportType: "SAFETY", status: "UNDER_REVIEW", booking: { status: "DISPUTED", statusBeforeDispute: "ONGOING" } };
test("safety cases cannot settle a completion dispute, and terminal bookings retain their payment outcome", () => {
  assert.deepEqual(allowedReportOutcomes(safety), ["dismiss", "resolve_safety", "cancel_booking"]);
  for (const status of ["COMPLETED", "CANCELED"]) assert.deepEqual(allowedReportOutcomes({ ...safety, booking: { ...safety.booking, status } }), ["dismiss", "resolve_safety"]);
  assert.throws(() => assertReportDecision(safety, "release_provider_and_complete", "none"), { code: "INVALID_REPORT_OUTCOME" });
});
test("completion decisions require the awaiting-confirmation path and no penalty can accompany dismissal", () => {
  assert.deepEqual(allowedReportOutcomes({ ...safety, reportType: "COMPLETION_DISPUTE", booking: { status: "DISPUTED", statusBeforeDispute: "AWAITING_CONFIRMATION" } }), ["dismiss", "cancel_booking", "release_provider_and_complete"]);
  assert.throws(() => assertReportDecision(safety, "dismiss", "ban"), { code: "DISMISSED_REPORT_PENALTY" });
  assert.doesNotThrow(() => assertReportDecision(safety, "resolve_safety", "warn"));
  assert.deepEqual(allowedReportOutcomes({ ...safety, status: "RESOLVED" }), []);
  assert.deepEqual(allowedReportOutcomes({ ...safety, reportType: "CANCELLATION_ESCALATION" }), []);
});
test("query filters are bounded, typed and support real active/history pagination", () => {
  assert.deepEqual(CaseQuerySchema.parse({}), { page: 1, limit: 12, view: "active", sort: "attention" });
  assert.equal(CaseQuerySchema.safeParse({ limit: 500 }).success, false);
  assert.equal(CaseQuerySchema.safeParse({ type: "PUBLIC_CONTENT" }).success, false);
  assert.equal(CaseQuerySchema.safeParse({ concern: "made up" }).success, false);
  assert.equal(CaseQuerySchema.safeParse({ view: "history", status: "DISMISSED", payment: "On-site Cash", search: "repair", sort: "oldest", page: "2" }).success, true);
  assert.equal(ReportResolutionSchema.safeParse({ outcome: "resolve_safety", adminNotes: "Evidence supports a warning.", penaltyAction: "warn" }).success, true);
});
test("invalid terminal cancellation is rejected before creating a durable resolution operation", async () => {
  let operationsCreated = 0;
  const report = { ...safety, id: "report-test", bookingId: "booking-test", booking: { ...safety.booking, status: "COMPLETED" } };
  const tx = { $executeRaw: async () => 0, report: { findUnique: async () => report }, adminResolutionOperation: { findUnique: async () => null, create: async () => { operationsCreated++; } } };
  const original = prisma.$transaction;
  (prisma as unknown as { $transaction: unknown }).$transaction = async (callback: (tx: unknown) => unknown) => callback(tx);
  try {
    await assert.rejects(resolveAdminReport("report-test", "admin-test", "cancel_booking", "Review terminal payment."), { code: "INVALID_REPORT_OUTCOME" });
    assert.equal(operationsCreated, 0);
  } finally { prisma.$transaction = original; }
});

test("a supported safety finding closes the case, restores only eligible paused work, and never rewrites a terminal payment", async () => {
  for (const terminal of [false, true]) {
    const booking = { id: "booking-test", seekerId: "seeker-test", providerId: "provider-test", paymentMethod: "GCash", status: terminal ? "COMPLETED" : "DISPUTED", statusBeforeDispute: terminal ? null : "ONGOING", paymentStatus: terminal ? "RELEASED" : "FROZEN_HELD" };
    const report = { ...safety, id: "report-test", bookingId: booking.id, reporterId: booking.seekerId, reportedUserId: booking.providerId, booking };
    let operation: Record<string, any> | null = null;
    let notificationCount = 0;
    const audits: string[] = [];
    const tx = {
      $executeRaw: async () => 0,
      report: { findUnique: async () => report, update: async ({ data }: { data: object }) => Object.assign(report, data), count: async () => ["PENDING", "UNDER_REVIEW"].includes(report.status) ? 1 : 0 },
      booking: { findUnique: async () => booking, updateMany: async ({ data }: { data: object }) => { Object.assign(booking, data); return { count: 1 }; } },
      queue: { updateMany: async () => ({ count: 1 }) }, cancellationRequest: { count: async () => 0 },
      adminResolutionOperation: {
        findUnique: async () => operation,
        findUniqueOrThrow: async () => operation,
        create: async ({ data }: { data: object }) => { operation = { ...data, id: "operation-test", status: "PROCESSING", stage: "CLAIMED" }; return operation; },
        updateMany: async ({ data }: { data: object }) => { Object.assign(operation!,data); return { count: 1 }; },
        update: async ({ data }: { data: object }) => Object.assign(operation!,data),
      },
      notification: { createMany: async ({ data }: { data: unknown[] }) => { notificationCount += data.length; } },
      adminAuditLog: { create: async ({ data }: { data: { action: string } }) => { audits.push(data.action); } },
    };
    const original = prisma.$transaction;
    (prisma as unknown as { $transaction: unknown }).$transaction = async (callback: (tx: unknown) => unknown) => callback(tx);
    try {
      await resolveAdminReport(report.id, "admin-test", "resolve_safety", "Evidence supports the safety finding.");
      assert.equal(report.status, "RESOLVED");
      assert.equal(booking.status, terminal ? "COMPLETED" : "ONGOING");
      assert.equal(booking.paymentStatus, terminal ? "RELEASED" : "PAID_HELD");
      assert.equal(notificationCount, 2);
      assert.deepEqual(audits, ["REPORT_RESOLVE_SAFETY"]);
      assert.equal((operation as Record<string, any> | null)?.status, "COMPLETED");
    } finally { prisma.$transaction = original; }
  }
});
