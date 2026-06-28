import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware";
import { prisma } from "../lib/prisma";

// ── GET /transactions ─────────────────────────────────────────────────────────
// Returns the authenticated user's wallet transaction history (earnings, refunds, withdrawals)
export async function getMyTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthenticatedRequest).user;

    const transactions = await prisma.transaction.findMany({
      where: { walletOwnerId: user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({ success: true, data: transactions });
  } catch (err) {
    next(err);
  }
}
