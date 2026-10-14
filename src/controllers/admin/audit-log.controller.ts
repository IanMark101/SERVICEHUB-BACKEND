import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import type { AuthenticatedRequest } from '../../middlewares/auth.middleware';
import { AuditHistoryQuery, auditDateRange } from '../../schema/audit-history.schema';

export async function listAdminAuditLogs(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const query = AuditHistoryQuery.parse(req.query);
    const { page, limit, action, search, kind } = query;
    const createdAt = auditDateRange(query);
    if (kind === 'security') {
      const where: Prisma.SecurityEventWhereInput = {
        createdAt,
        ...(action ? { action } : {}),
        ...(search ? { OR: [
          { userId: { contains: search, mode: 'insensitive' } },
          { user: { name: { contains: search, mode: 'insensitive' } } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
          { ipAddress: { contains: search, mode: 'insensitive' } },
          { sessionReference: { contains: search, mode: 'insensitive' } },
        ] } : {}),
      };
      // The private history is never returned unless this access record commits.
      await prisma.adminAuditLog.create({ data: {
        actorId: (req as AuthenticatedRequest).user.id,
        action: 'USER_SECURITY_HISTORY_VIEWED', resourceType: 'SecurityHistory',
        reason: 'Viewed user sign-in and security history',
        metadata: { page, limit, action: action || 'ALL', from: query.from ?? null, to: query.to ?? null },
      } });
      const [items, total] = await Promise.all([
        prisma.securityEvent.findMany({ where, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
        prisma.securityEvent.count({ where }),
      ]);
      return res.json({ success: true, kind, data: items, retentionDays: env.SECURITY_LOG_RETENTION_DAYS, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    const where: Prisma.AdminAuditLogWhereInput = {
      createdAt,
      ...(action ? { action: { contains: action, mode: 'insensitive' } } : {}),
      ...(search ? { OR: [
        { action: { contains: search, mode: 'insensitive' } },
        { reason: { contains: search, mode: 'insensitive' } },
        { actor: { name: { contains: search, mode: 'insensitive' } } },
        { actor: { email: { contains: search, mode: 'insensitive' } } },
        { targetUser: { name: { contains: search, mode: 'insensitive' } } },
      ] } : {}),
    };
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
    res.json({ success: true, kind, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    next(error);
  }
}
