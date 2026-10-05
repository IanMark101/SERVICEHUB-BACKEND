import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { reportMutationLimiter } from "../middlewares/rateLimiter.middleware";
import { createContentCase, getMyContentCases } from "../controllers/content-cases.controller";

const router = Router();
router.use(requireAuth, requireMarketplaceUser);
router.post("/", reportMutationLimiter, createContentCase);
router.get("/mine", getMyContentCases);
export default router;
