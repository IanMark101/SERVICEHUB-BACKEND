import { prisma } from "../lib/prisma";
// ── GET /transactions ─────────────────────────────────────────────────────────
// Returns the authenticated user's wallet transaction history (earnings, refunds, withdrawals)
export async function getMyTransactions(req, res, next) {
    try {
        const user = req.user;
        const transactions = await prisma.transaction.findMany({
            where: { walletOwnerId: user.id },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        res.json({ success: true, data: transactions });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=transactions.controller.js.map