"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMyTransactions = getMyTransactions;
const prisma_1 = require("../lib/prisma");
// ── GET /transactions ─────────────────────────────────────────────────────────
// Returns the authenticated user's wallet transaction history (earnings, refunds, withdrawals)
async function getMyTransactions(req, res, next) {
    try {
        const user = req.user;
        const transactions = await prisma_1.prisma.transaction.findMany({
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