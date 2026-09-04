import { prisma } from "../lib/prisma";
import { recalculateQueue, notifyWaitlist } from "./queue.service";
import { disconnectUserSockets, safeEmit, safeBroadcast } from "../lib/socket";
import { ReportStatus } from "@prisma/client";
import { refundBookingPayment } from "./payment-refund.service";
import { settleCompletedBooking } from "./bookings/completion.service";

export type ReportAction = "warn" | "trust_deduct" | "suspend" | "ban" | "approve_refund" | "release_provider_and_complete" | "dismiss";

const reportInclude = {
  reporter: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
  reportedUser: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
  booking: {
    include: {
      seeker: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
      provider: { select: { id: true, name: true, trustScore: true, verificationStatus: true } },
      service: { select: { id: true, title: true, price: true } },
      offer: { include: { request: { select: { id: true, title: true } } } },
      directRequest: { include: { service: { select: { id: true, title: true } } } },
      messages: { orderBy: { createdAt: "asc" as const } },
      queue: true,
      cancellationRequests: { where: { status: "ESCALATED" } },
    },
  },
} as const;

export async function listAdminReports(page = 1, limit = 10) {
  const where = { status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] } };
  const [reports, total] = await Promise.all([
    prisma.report.findMany({
      where,
      include: reportInclude,
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.report.count({ where }),
  ]);

  const items = reports.map((report) => ({
    ...report,
    booking: {
      ...report.booking,
      title:
        report.booking.service?.title ||
        report.booking.offer?.request.title ||
        report.booking.directRequest?.service.title ||
        "Service engagement",
      amount: Number(
        report.booking.agreedAmount ||
        report.booking.directRequest?.agreedPrice ||
        report.booking.offer?.offeredPrice ||
        report.booking.service?.price ||
        0,
      ),
      messages: report.booking.messages.map((message) => ({ ...message, text: message.content })),
      escalatedCancellation: report.booking.cancellationRequests[0] || null,
    },
  }));
  return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

function activityLink(report: { booking: { seekerId: string; providerId: string } }, userId: string, tab = "all") {
  return userId === report.booking.providerId
    ? `/provider/provider-activity?tab=${tab}`
    : `/seeker/seeker-activity?tab=${tab}`;
}

export async function resolveAdminReport(
  reportId: string,
  adminId: string,
  action: ReportAction,
  adminNotes: string,
) {
  if (action === "approve_refund") {
    return resolveRefundReport(reportId, adminId, adminNotes);
  }
  if (action === "release_provider_and_complete") {
    return resolveReleaseReport(reportId, adminId, adminNotes);
  }

  const report = await prisma.$transaction(async (tx) => {
    const current = await tx.report.findUnique({
      where: { id: reportId },
      include: { booking: true, reporter: true, reportedUser: true },
    });
    if (!current) {
      const error = new Error("Report not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    const claimed = await tx.report.updateMany({
      where: { id: reportId, status: { in: ["PENDING", "UNDER_REVIEW"] } },
      data: {
        status: action === "dismiss" ? "DISMISSED" : "RESOLVED",
        adminId,
        adminNotes,
        resolvedAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      const error = new Error("Report has already been resolved") as Error & { status?: number };
      error.status = 409;
      throw error;
    }

    if (action === "trust_deduct") {
      const rows = await tx.$queryRaw<Array<{ trustScore: number }>>`
        SELECT "trustScore" FROM "users" WHERE "id" = ${current.reportedUserId} FOR UPDATE
      `;
      const scoreBefore = rows[0].trustScore;
      const scoreAfter = Math.max(0, scoreBefore - 10);
      await tx.user.update({ where: { id: current.reportedUserId }, data: { trustScore: scoreAfter } });
      await tx.trustScoreEvent.create({
        data: {
          userId: current.reportedUserId,
          delta: scoreAfter - scoreBefore,
          reason: "Valid report confirmed by administrator",
          scoreBefore,
          scoreAfter,
          actorAdminId: adminId,
        },
      });
    } else if (action === "suspend" || action === "ban") {
      const unstartedProviderBookings = await tx.booking.count({
        where: {
          providerId: current.reportedUserId,
          started: false,
          status: { in: ["PENDING_APPROVAL", "WAITING", "ACCEPTED"] },
        },
      });
      if (unstartedProviderBookings > 0) {
        const error = new Error(
          `Resolve or administratively cancel the provider's ${unstartedProviderBookings} unstarted booking(s) before suspension or banning`,
        ) as Error & { status?: number };
        error.status = 409;
        throw error;
      }
      const suspendedUntil = action === "suspend"
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null;
      await tx.user.update({
        where: { id: current.reportedUserId },
        data: {
          isActive: true,
          moderationStatus: action === "ban" ? "BANNED" : "SUSPENDED",
          suspendedUntil,
          moderationReason: adminNotes,
        },
      });
    } else if (action === "dismiss" && ["DISPUTED", "UNDER_REVIEW"].includes(current.booking.status)) {
      const restoredStatus = current.booking.statusBeforeDispute || "AWAITING_CONFIRMATION";
      const restoredPayment = current.booking.paymentMethod === "On-site Cash" ? "UNPAID" : "PAID_HELD";
      await tx.booking.update({
        where: { id: current.bookingId },
        data: { status: restoredStatus, statusBeforeDispute: null, paymentStatus: restoredPayment },
      });
      await tx.queue.updateMany({ where: { bookingId: current.bookingId }, data: { paymentStatus: restoredPayment } });
    }

    await tx.cancellationRequest.updateMany({
      where: { bookingId: current.bookingId, status: "ESCALATED" },
      data: { status: "RESOLVED", adminId, adminNote: adminNotes, resolvedAt: new Date() },
    });
    await tx.notification.createMany({
      data: [
        {
          userId: current.reporterId,
          title: "Report Resolved",
          body: `Your report has been reviewed. ${adminNotes}`,
          link: `${activityLink(current, current.reporterId)}&booking=${current.bookingId}`,
        },
        {
          userId: current.reportedUserId,
          title: action === "warn" ? "Official Administrator Warning" : "Report Against You Resolved",
          body: `The report has been resolved with action: ${action.replace(/_/g, " ")}. ${adminNotes}`,
          link: `${activityLink(current, current.reportedUserId)}&booking=${current.bookingId}`,
        },
      ],
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: adminId,
        targetUserId: current.reportedUserId,
        action: `REPORT_${action.toUpperCase()}`,
        resourceType: "Report",
        resourceId: current.id,
        reason: adminNotes,
        metadata: { bookingId: current.bookingId },
      },
    });
    return current;
  });

  safeEmit(`user:${report.reporterId}`, "notification", { title: "Report Resolved" });
  safeEmit(`user:${report.reportedUserId}`, "notification", { title: "Report Against You Resolved" });
  safeBroadcast("ADMIN_MODERATION_CHANGED", { reportId, action });
  return { resolved: true, action };
}

async function resolveRefundReport(reportId: string, adminId: string, adminNotes: string) {
  const report = await prisma.report.findUnique({ where: { id: reportId }, include: reportInclude });
  if (!report) {
    const error = new Error("Report not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  if (report.status !== "PENDING") {
    const error = new Error("Report is already being reviewed or resolved") as Error & { status?: number };
    error.status = 409;
    throw error;
  }
  if (!report.booking.queue || !["PAID_HELD", "FROZEN_HELD"].includes(report.booking.paymentStatus)) {
    const error = new Error("Only a held online payment can be refunded") as Error & { status?: number };
    error.status = 422;
    throw error;
  }

  const claimed = await prisma.report.updateMany({
    where: { id: reportId, status: "PENDING" },
    data: { status: "UNDER_REVIEW", adminId, adminNotes },
  });
  if (claimed.count !== 1) {
    const error = new Error("Report is already being reviewed") as Error & { status?: number };
    error.status = 409;
    throw error;
  }

  let refund: Awaited<ReturnType<typeof refundBookingPayment>>;
  try {
    refund = await refundBookingPayment(
      report.bookingId,
      adminId,
      `Administrator-approved refund: ${adminNotes}`,
    );
  } catch (cause) {
    const failureReason = cause instanceof Error ? cause.message : "PayMongo refund failed";
    const refundRecord = await prisma.paymentRefund.findUnique({ where: { bookingId: report.bookingId } });
    const canRetry = !refundRecord || refundRecord.status === "FAILED";
    await prisma.$transaction(async (tx) => {
      if (canRetry) {
        await tx.report.update({ where: { id: reportId }, data: { status: "PENDING", adminId: null, adminNotes: null } });
      }
      await tx.adminAuditLog.create({
        data: { actorId: adminId, targetUserId: report.reportedUserId, action: "REFUND_FAILED", resourceType: "Report", resourceId: reportId, reason: failureReason },
      });
    });
    throw cause;
  }

  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id: reportId },
      data: { status: "RESOLVED", adminId, adminNotes, resolvedAt: new Date() },
    });
    await tx.cancellationRequest.updateMany({
      where: { bookingId: report.bookingId, status: "ESCALATED" },
      data: { status: "RESOLVED", adminId, adminNote: adminNotes, resolvedAt: new Date() },
    });
    await tx.notification.createMany({
      data: [
        { userId: report.reporterId, title: "Refund Approved", body: `Your refund was submitted to PayMongo. ${adminNotes}`, link: `${activityLink(report, report.reporterId, "canceled")}&booking=${report.bookingId}` },
        { userId: report.reportedUserId, title: "Booking Refunded", body: `The booking was canceled and refunded. ${adminNotes}`, link: `${activityLink(report, report.reportedUserId, "canceled")}&booking=${report.bookingId}` },
      ],
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: adminId,
        targetUserId: report.reportedUserId,
        action: "REPORT_REFUND_APPROVED",
        resourceType: "Report",
        resourceId: reportId,
        reason: adminNotes,
        metadata: { bookingId: report.bookingId, refundId: refund.refundId, amount: refund.amount },
      },
    });
  });

  await recalculateQueue(report.booking.queue.serviceId);
  await notifyWaitlist(report.booking.queue.serviceId);
  safeEmit(`user:${report.reporterId}`, "notification", { title: "Refund Approved" });
  safeEmit(`user:${report.reportedUserId}`, "notification", { title: "Booking Refunded" });
  safeBroadcast("ADMIN_MODERATION_CHANGED", { reportId, action: "approve_refund" });
  return { resolved: true, action: "approve_refund", refundId: refund.refundId };
}

async function resolveReleaseReport(reportId: string, adminId: string, adminNotes: string) {
  const report = await prisma.report.findUnique({ where: { id: reportId }, include: { booking: true } });
  if (!report) {
    const error = new Error("Report not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  if (!(["PENDING", "UNDER_REVIEW"] as string[]).includes(report.status)) {
    const error = new Error("Report has already been resolved") as Error & { status?: number };
    error.status = 409;
    throw error;
  }
  if (report.booking.status !== "DISPUTED") {
    const error = new Error("Only a disputed booking can be released and completed") as Error & { status?: number };
    error.status = 422;
    throw error;
  }

  const claimedForReview = await prisma.report.updateMany({
    where: { id: reportId, status: "PENDING" },
    data: { status: "UNDER_REVIEW", adminId, adminNotes },
  });
  if (claimedForReview.count !== 1) {
    const error = new Error("Report is already being resolved") as Error & { status?: number };
    error.status = 409;
    throw error;
  }

  let completed: Awaited<ReturnType<typeof settleCompletedBooking>>;
  try {
    completed = await settleCompletedBooking(report.bookingId, { type: "ADMIN", userId: adminId });
  } catch (cause) {
    await prisma.report.updateMany({
      where: { id: reportId, status: "UNDER_REVIEW", adminId },
      data: { status: "PENDING", adminId: null, adminNotes: null },
    });
    throw cause;
  }
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.report.updateMany({
      where: { id: reportId, status: "UNDER_REVIEW", adminId },
      data: { status: "RESOLVED", adminId, adminNotes, resolvedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    await tx.adminAuditLog.create({
      data: {
        actorId: adminId,
        targetUserId: report.reportedUserId,
        action: "REPORT_RELEASE_PROVIDER_AND_COMPLETE",
        resourceType: "Report",
        resourceId: reportId,
        reason: adminNotes,
        metadata: { bookingId: report.bookingId, completedServiceId: completed.id },
      },
    });
  });
  safeBroadcast("ADMIN_MODERATION_CHANGED", { reportId, action: "release_provider_and_complete" });
  return { resolved: true, action: "release_provider_and_complete", completedServiceId: completed.id };
}
