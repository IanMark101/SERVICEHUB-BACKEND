import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { aiLimiter } from "../middlewares/rateLimiter.middleware";
import { getProviderSummary, matchProviders } from "../controllers/ai.controller";
const router = Router();
// Review summaries can invoke Gemini and consume paid quota; do not expose
// that capability to anonymous callers.
router.get("/provider-summary/:providerId", aiLimiter, requireAuth, requireMarketplaceUser, getProviderSummary);
router.post("/match-providers", aiLimiter, requireAuth, requireMarketplaceUser, matchProviders);
export default router;
//# sourceMappingURL=ai.routes.js.map