import { Router } from "express";
import { requireAuth, requireMarketplaceUser } from "../middlewares/auth.middleware";
import { submitReview, getProviderReviews } from "../controllers/reviews.controller";

const router = Router();

router.post("/", requireAuth, requireMarketplaceUser, submitReview);
router.get("/provider/:providerId", getProviderReviews);

export default router;
