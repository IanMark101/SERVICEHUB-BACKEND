import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { getProviderSummary, matchProviders } from "../controllers/ai.controller";

const router = Router();

router.get("/provider-summary/:providerId", getProviderSummary);
router.post("/match-providers", requireAuth, matchProviders);

export default router;
