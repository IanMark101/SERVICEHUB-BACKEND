import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";
import { getPublicServiceCount } from "../../services/services.service";

type CreatedRecord = { createdAt: Date };

function toUtcDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function buildSevenDayActivity(
  start: Date,
  users: CreatedRecord[],
  services: CreatedRecord[],
  bookings: CreatedRecord[],
) {
  const activity = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return {
      date: toUtcDateKey(date),
      registrations: 0,
      listings: 0,
      bookings: 0,
    };
  });
  const byDate = new Map(activity.map((item) => [item.date, item]));

  for (const user of users) {
    const item = byDate.get(toUtcDateKey(user.createdAt));
    if (item) item.registrations += 1;
  }
  for (const service of services) {
    const item = byDate.get(toUtcDateKey(service.createdAt));
    if (item) item.listings += 1;
  }
  for (const booking of bookings) {
    const item = byDate.get(toUtcDateKey(booking.createdAt));
    if (item) item.bookings += 1;
  }

  return activity;
}

export async function getOverview(_req: Request, res: Response, next: NextFunction) {
  try {
    const activityStart = new Date();
    activityStart.setUTCHours(0, 0, 0, 0);
    activityStart.setUTCDate(activityStart.getUTCDate() - 6);

    const [
      totalUsers,
      activeServices,
      pendingVerifications,
      openReports,
      openCompletionEscalations,
      escalatedCancellations,
      pendingBanAppeals,
      categorySuggestions,
      recentAuditLogs,
      bookingStatusCounts,
      recentUsers,
      recentServices,
      recentBookings,
    ] = await Promise.all([
      prisma.user.count({ where: { role: { not: "admin" } } }),
      getPublicServiceCount(),
      prisma.serviceVerification.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.report.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] }, reportType: { not: "CANCELLATION_ESCALATION" } } }),
      prisma.completionEscalation.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
      prisma.cancellationRequest.count({ where: { status: { in: ["ESCALATED", "UNDER_REVIEW"] } } }),
      prisma.banAppeal.count({ where: { status: "PENDING" } }),
      prisma.categorySuggested.count({ where: { status: "PENDING" } }),
      prisma.adminAuditLog.findMany({
        include: { actor: { select: { id: true, name: true } }, targetUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      prisma.booking.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.findMany({
        where: { role: { not: "admin" }, createdAt: { gte: activityStart } },
        select: { createdAt: true },
      }),
      prisma.service.findMany({
        where: { createdAt: { gte: activityStart } },
        select: { createdAt: true },
      }),
      prisma.booking.findMany({
        where: { createdAt: { gte: activityStart } },
        select: { createdAt: true },
      }),
    ]);

    const statusCount = new Map<string, number>(
      bookingStatusCounts.map((item) => [item.status, item._count._all]),
    );
    const countStatuses = (...statuses: string[]) =>
      statuses.reduce((total, status) => total + (statusCount.get(status) ?? 0), 0);

    res.json({
      success: true,
      data: {
        totalUsers,
        activeServices,
        pendingVerifications,
        openReports: openReports + openCompletionEscalations + escalatedCancellations,
        categorySuggestions,
        pendingBanAppeals,
        recentAuditLogs,
        moderationWorkload: [
          { label: "Verifications", count: pendingVerifications, href: "/admin/verifications" },
          { label: "Reports & disputes", count: openReports + openCompletionEscalations + escalatedCancellations, href: "/admin/reports" },
          { label: "Category requests", count: categorySuggestions, href: "/admin/categories" },
          { label: "Ban appeals", count: pendingBanAppeals, href: "/admin/users?appeals=pending" },
        ],
        bookingLifecycle: [
          { label: "Waiting", count: countStatuses("PENDING_APPROVAL", "WAITING", "ACCEPTED") },
          { label: "In service", count: countStatuses("ONGOING") },
          { label: "Awaiting confirmation", count: countStatuses("AWAITING_CONFIRMATION") },
          { label: "Needs review", count: countStatuses("UNDER_REVIEW", "DISPUTED") },
          { label: "Completed", count: countStatuses("COMPLETED") },
          { label: "Closed without completion", count: countStatuses("DECLINED", "CANCELED", "REMOVED") },
        ],
        sevenDayActivity: buildSevenDayActivity(activityStart, recentUsers, recentServices, recentBookings),
      },
    });
  } catch (err) {
    next(err);
  }
}
