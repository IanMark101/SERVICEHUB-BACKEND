import type { ReportReason } from "@prisma/client";
import { getPrivateVerificationUrl } from "../config/cloudinary";
import { prisma } from "../lib/prisma";
import { safeEmit } from "../lib/socket";

const ELIGIBLE_STATUSES = ["ACCEPTED", "ONGOING", "AWAITING_CONFIRMATION", "UNDER_REVIEW", "DISPUTED", "COMPLETED", "CANCELED"];

function httpError(message: string, status: number) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

export async function createSafetyReport(params: {
  bookingId: string;
  reporterId: string;
  reason: ReportReason;
  description: string;
  evidenceStorageKey?: string;
}) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`safety-report:${params.bookingId}:${params.reporterId}`}))`;
    const booking = await tx.booking.findUnique({ where: { id: params.bookingId } });
    if (!booking || ![booking.seekerId, booking.providerId].includes(params.reporterId)) {
      throw httpError("Booking not found or access denied", 404);
    }
    if (!ELIGIBLE_STATUSES.includes(booking.status)) throw httpError("This booking is not eligible for a safety report", 409);
    const reportedUserId = booking.seekerId === params.reporterId ? booking.providerId : booking.seekerId;
    if (params.evidenceStorageKey && !params.evidenceStorageKey.startsWith(`servicehub/safety/${booking.id}/${params.reporterId}/`)) {
      throw httpError("Safety evidence does not belong to this booking participant", 403);
    }
    const existing = await tx.report.findFirst({
      where: { bookingId: booking.id, reporterId: params.reporterId, reportType: "SAFETY", status: { in: ["PENDING", "UNDER_REVIEW"] } },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { report: existing, created: false, admins: [] as { id: string }[] };

    const report = await tx.report.create({
      data: { bookingId: booking.id, reporterId: params.reporterId, reportedUserId, reason: params.reason, description: params.description, evidenceStorageKey: params.evidenceStorageKey, reportType: "SAFETY" },
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
    return { report, created: true, admins };
  });
  if (result.created) {
    result.admins.forEach((admin) => safeEmit(`user:${admin.id}`, "notification", { title: "Safety report requires review" }));
    safeEmit("admin", "ADMIN_MODERATION_CHANGED", { type: "safety_report", reportId: result.report.id });
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
