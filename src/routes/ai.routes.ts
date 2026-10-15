import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { aiLimiter } from "../middlewares/rateLimiter.middleware";
import { getProviderSummary, getSeekerSummary, matchProviders, categorySuggestions, matchRequests } from "../controllers/ai.controller";

const router = Router();

// Review summaries can invoke Gemini and consume paid quota; do not expose
// that capability to anonymous callers.
router.get("/provider-summary/:providerId", aiLimiter, requireAuth, requireMarketplaceUser, getProviderSummary);
router.get("/seeker-summary/:seekerId", aiLimiter, requireAuth, requireMarketplaceUser, getSeekerSummary);
router.post("/match-providers", requireAuth, requireMarketplaceUser, aiLimiter, matchProviders);
router.post("/match-requests", requireAuth, requireMarketplaceUser, aiLimiter, matchRequests);
router.post("/suggest-category", requireAuth, requireMarketplaceUser, aiLimiter, categorySuggestions);

export default router;
