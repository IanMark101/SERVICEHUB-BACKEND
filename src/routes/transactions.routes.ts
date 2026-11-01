import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { getMyTransactions, getMyProviderPaymentRecords } from "../controllers/transactions.controller";
import { getProviderAnalytics } from '../services/provider-analytics.service';
import type { AuthenticatedRequest } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth, requireMarketplaceUser);

// Provider-only booking history and lifetime recorded earnings; no money mutation.
router.get('/provider-records', getMyProviderPaymentRecords);
router.get('/provider-analytics', async (req, res, next) => {
  try { res.json({ success: true, data: await getProviderAnalytics((req as AuthenticatedRequest).user.id) }); } catch (error) { next(error); }
});

// GET /transactions — provider's own transaction/earning history
router.get("/", getMyTransactions);

export default router;
