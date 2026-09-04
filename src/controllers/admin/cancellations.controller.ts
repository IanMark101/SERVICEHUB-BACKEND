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
    const items = await prisma.cancellationRequest.findMany({
      where: { status: "ESCALATED" },
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
    });
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
}
