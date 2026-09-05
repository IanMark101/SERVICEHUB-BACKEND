import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../../middlewares/auth.middleware";
import { prisma } from "../../lib/prisma";
import { BooleanDecisionSchema } from "../../schema/marketplace.schema";

export async function resolveCancellationRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { approve, adminNotes: adminNote } = BooleanDecisionSchema.parse(req.body);
    const { adminResolveCancellationRequest } = await import("../../services/cancellation.service");
    const result = await adminResolveCancellationRequest(
      req.params.id as string,
      approve,
      adminNote,
      (req as AuthenticatedRequest).user.id,
    );
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── GET /admin/cancellations/escalated ───────────────────────────────────────

export async function listEscalatedCancellations(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const where = { status: "ESCALATED" };
    const [items, total] = await Promise.all([prisma.cancellationRequest.findMany({
      where,
      include: {
        booking: {
          include: {
            seeker: { select: { id: true, name: true, email: true, trustScore: true } },
            provider: { select: { id: true, name: true, email: true, trustScore: true } },
            service: { select: { title: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }), prisma.cancellationRequest.count({ where })]);
    res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}
