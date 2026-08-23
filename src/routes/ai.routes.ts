import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { aiLimiter } from "../middlewares/rateLimiter.middleware";
import { getProviderSummary, matchProviders } from "../controllers/ai.controller";

const router = Router();

router.get("/provider-summary/:providerId", aiLimiter, getProviderSummary);
router.post("/match-providers", aiLimiter, requireAuth, requireMarketplaceUser, matchProviders);

export default router;
