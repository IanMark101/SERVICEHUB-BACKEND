import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../lib/prisma";

export async function getOverview(_req: Request, res: Response, next: NextFunction) {
  try {
    const [totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions, recentAuditLogs] = await Promise.all([
      prisma.user.count({ where: { role: { not: "admin" } } }),
      prisma.service.count({ where: { status: "ACTIVE", isAvailable: true, provider: { isActive: true } } }),
      prisma.serviceVerification.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.report.count({ where: { status: { in: ["PENDING", "UNDER_REVIEW"] } } }),
      prisma.service.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.categorySuggested.count({ where: { status: "PENDING" } }),
      prisma.adminAuditLog.findMany({
        include: { actor: { select: { id: true, name: true } }, targetUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

    res.json({
      success: true,
      data: { totalUsers, activeServices, pendingVerifications, openReports, pendingListings, categorySuggestions, recentAuditLogs },
    });
  } catch (err) {
    next(err);
  }
}
