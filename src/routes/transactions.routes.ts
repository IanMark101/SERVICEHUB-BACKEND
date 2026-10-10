import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { getMyTransactions, getMyProviderPaymentRecords } from "../controllers/transactions.controller";

const router = Router();

router.use(requireAuth, requireMarketplaceUser);

// Provider-only booking history and lifetime recorded earnings; no money mutation.
router.get('/provider-records', getMyProviderPaymentRecords);

// GET /transactions — provider's own transaction/earning history
router.get("/", getMyTransactions);

export default router;
