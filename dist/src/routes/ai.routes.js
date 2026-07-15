import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { getProviderSummary, matchProviders } from "../controllers/ai.controller";
const router = Router();
router.get("/provider-summary/:providerId", getProviderSummary);
router.post("/match-providers", requireAuth, requireMarketplaceUser, matchProviders);
export default router;
//# sourceMappingURL=ai.routes.js.map