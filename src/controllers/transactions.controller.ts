import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";

// ── GET /transactions ─────────────────────────────────────────────────────────
// Returns the authenticated user's wallet transaction history (earnings, refunds, withdrawals)
export async function getMyTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;

    const page = Math.max(1, Number.parseInt(String(req.query?.page || "1"), 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query?.limit || "20"), 10) || 20));
    const where = { walletOwnerId: user.id };
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.transaction.count({ where }),
    ]);

    res.json({ success: true, data: transactions, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}
