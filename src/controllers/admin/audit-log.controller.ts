import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../lib/prisma";

export async function listAdminAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const action = typeof req.query.action === "string" ? req.query.action.trim() : "";
    const where = action ? { action: { contains: action, mode: "insensitive" as const } } : {};
    const [items, total] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        include: { actor: { select: { id: true, name: true, email: true } }, targetUser: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.adminAuditLog.count({ where }),
    ]);
    res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}
