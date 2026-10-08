import type { ReportReason } from "@prisma/client";
import { createHash } from "node:crypto";
import { getPrivateVerificationUrl } from "../config/cloudinary";
import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";
import { assertNoRefundInProgress, lockBookingLifecycle } from "./booking-lifecycle.service";
import { assertNoFinancialResolutionReserved } from "./case-resolution.service";
import { assertActiveMarketplaceAccount, lockAccountLifecycle } from "./account-lifecycle.service";

const ELIGIBLE_STATUSES = ["ACCEPTED", "ONGOING", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED", "COMPLETED", "CANCELED"];

function httpError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function safetyIncidentKey(input: { bookingId: string; reporterId: string; reason: ReportReason; description: string }) {
  const normalizedDescription = input.description.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  return createHash("sha256")
    .update([input.bookingId, input.reporterId, "SAFETY", input.reason, normalizedDescription].join("\u001f"))
    .digest("hex");
}

export async function createSafetyReport(params: {
  bookingId: string;
  reporterId: string;
  reason: ReportReason;
  description: string;
  evidenceStorageKey?: string;
}) {
  const dedupeKey = safetyIncidentKey(params);
  const result = await prisma.$transaction(async (tx) => {
    await lockBookingLifecycle(tx, params.bookingId);
    const booking = await tx.booking.findUnique({ where: { id: params.bookingId } });
    if (!booking || ![booking.seekerId, booking.providerId].includes(params.reporterId)) {
      throw httpError("Booking not found or access denied", 404);
    }
    await lockAccountLifecycle(tx, booking.seekerId, booking.providerId);
    await assertActiveMarketplaceAccount(tx, params.reporterId);
    if (!ELIGIBLE_STATUSES.includes(booking.status)) throw httpError("This booking is not eligible for a safety report", 409);
    if (!booking.started && ["POOR_SERVICE_QUALITY", "INCOMPLETE_SERVICE"].includes(params.reason)) {
      throw httpError("Service quality and incomplete-service reports are available only after the provider starts the job.", 409);
    }
    await assertNoRefundInProgress(tx, booking.id);
    await assertNoFinancialResolutionReserved(tx, booking.id);
    const reportedUserId = booking.seekerId === params.reporterId ? booking.providerId : booking.seekerId;
    if (params.evidenceStorageKey && !params.evidenceStorageKey.startsWith(`servicehub/safety/${booking.id}/${params.reporterId}/`)) {
      throw httpError("Safety evidence does not belong to this booking participant", 403);
    }
    const existing = await tx.report.findFirst({
      where: { dedupeKey, status: { in: ["PENDING", "UNDER_REVIEW"] } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { report: existing, created: false, admins: [] as { id: string }[], participantIds: [] as string[] };

    const report = await tx.report.create({
      data: { bookingId: booking.id, reporterId: params.reporterId, reportedUserId, reason: params.reason, description: params.description.trim(), evidenceStorageKey: params.evidenceStorageKey, reportType: "SAFETY", dedupeKey },
    });
    if (["ACCEPTED", "ONGOING", "AWAITING_CONFIRMATION"].includes(booking.status)) {
      await tx.booking.update({
        where: { id: booking.id },
        data: { statusBeforeDispute: booking.status, status: "DISPUTED", ...(booking.paymentStatus === "PAID_HELD" ? { paymentStatus: "FROZEN_HELD" } : {}) },
      });
      if (booking.paymentStatus === "PAID_HELD") {
        await tx.queue.updateMany({ where: { bookingId: booking.id }, data: { paymentStatus: "FROZEN_HELD" } });
      }
    }
    const admins = await tx.user.findMany({ where: { role: "admin", isActive: true, moderationStatus: "ACTIVE" }, select: { id: true } });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((admin) => ({ userId: admin.id, title: "Safety report requires review", body: "A booking participant submitted a safety report.", link: `/admin/reports?report=${report.id}` })),
      });
    }
    return { report, created: true, admins, participantIds: [booking.seekerId, booking.providerId] };
  });
  if (result.created) {
    result.admins.forEach((admin) => safeEmit(`user:${admin.id}`, "notification", { title: "Safety report requires review" }));
    safeEmit("admin", "ADMIN_MODERATION_CHANGED", { type: "safety_report", reportId: result.report.id });
    result.participantIds.forEach(userId => safeEmit(`user:${userId}`, "ENGAGEMENT_CHANGED", { bookingId: params.bookingId, type: 'safety_report' }));
  }
  const { evidenceStorageKey: _key, ...safeReport } = result.report;
  return { ...safeReport, hasPrivateEvidence: Boolean(result.report.evidenceStorageKey), created: result.created };
}

export async function accessSafetyReportEvidence(reportId: string, adminId: string, action: "view" | "download") {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report?.evidenceStorageKey) throw httpError("Private report evidence not found", 404);
  await prisma.adminAuditLog.create({
    data: { actorId: adminId, targetUserId: report.reportedUserId, action: action === "download" ? "REPORT_EVIDENCE_DOWNLOADED" : "REPORT_EVIDENCE_VIEWED", resourceType: "Report", resourceId: report.id, reason: `Administrator ${action}ed private safety evidence`, metadata: { bookingId: report.bookingId } },
  });
  return { url: getPrivateVerificationUrl(report.evidenceStorageKey, action === "download"), expiresInSeconds: 300 };
}
